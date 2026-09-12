"""Fitting the seven block weights to realised outcomes.

`pattern_service.BLOCK_WEIGHTS` decides how much each feature block counts
toward similarity -- close shape 1.0, returns 0.9, body 0.6, the wicks 0.4,
and so on.  Those numbers were chosen by hand and have never been checked
against anything.  This module chooses them by asking which set made the
most similar windows in a *training* stretch of history the most profitable.

That is genuinely a fitted model, and it is also the most overfittable thing
in this codebase: seven free parameters, an objective read off a few dozen
trades, and a search that will happily find whichever set flattered the noise.
Three things hold it down, and none of them are optional.

**It is fit on history the result is not reported from.**  The caller splits
the lookback in two, fits here on the earlier part, and runs the actual
backtest on the later part.  Weights that only memorised the training stretch
show up as a result no better than the hand-set ones out of sample, which is
the outcome this is designed to make visible rather than hide.

**It reports what the hand-set weights scored on the same data.**  A fit that
cannot beat the defaults on the very data it was fitted to has found nothing,
and saying so is more useful than a number with nothing beside it.

**It stays legible.**  The whole model is seven values between 0 and 1.  A
match remains explainable as the same cosine over the same features, and the
weights can simply be printed next to the result.

The search itself is deterministic: a fixed grid, blocks visited in a fixed
order, ties kept by the incumbent.  Running the same fit twice produces the
same weights, for the same reason the pattern search and the baseline draw
are reproducible -- a model that moved between runs could not be reported on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

logger = logging.getLogger(__name__)

#: Values each weight may take. Coarse on purpose: the objective is read off a
#: few dozen trades, and a finer grid would only let the search chase noise it
#: cannot distinguish from signal.
WEIGHT_GRID: tuple[float, ...] = (0.0, 0.25, 0.5, 0.75, 1.0)

#: Full sweeps over the blocks before stopping. Coordinate ascent on a grid
#: this coarse settles in two or three; the cap is a guard, not a target.
MAX_PASSES = 4

#: An improvement smaller than this is noise in the objective, not a better
#: set of weights, and taking it would make the result depend on float order.
MIN_IMPROVEMENT = 1e-9


@dataclass(frozen=True)
class LearnedWeights:
    """A fitted weight set and everything needed to judge it."""

    weights: dict[str, float]
    #: Objective value on the training windows.
    train_score: float
    #: What the hand-set weights scored on those same windows. If the fit is
    #: not above this, it found nothing.
    default_score: float
    #: Training windows that could actually be simulated and scored.
    labelled_windows: int
    #: Windows averaged for each score -- the top-k by similarity.
    top_k: int
    passes: int
    objective: str
    #: Blocks the fit switched off entirely, named for the notes.
    dropped_blocks: list[str] = field(default_factory=list)

    #: The same objective on windows the fit never saw, for the learned set
    #: and for the hand-set one. `None` when the holdout was too small to
    #: score, which is itself worth reporting rather than papering over.
    holdout_score: float | None = None
    holdout_default_score: float | None = None
    holdout_windows: int = 0

    @property
    def improved(self) -> bool:
        """Beat the defaults on the data it was fitted to.

        Weak evidence on its own: seven free parameters against a few dozen
        trades will nearly always manage it. :attr:`generalised` is the one
        that matters.
        """

        return self.train_score > self.default_score

    @property
    def generalised(self) -> bool | None:
        """Still beat the defaults on data it never saw.

        ``None`` when there was no holdout to judge on. ``False`` is the
        honest and common answer, and the reason the split exists.
        """

        if self.holdout_score is None or self.holdout_default_score is None:
            return None
        return self.holdout_score > self.holdout_default_score


def similarity_for_weights(
    dots: np.ndarray,
    query_norms: np.ndarray,
    candidate_norms: np.ndarray,
    weights: np.ndarray,
) -> np.ndarray:
    """Cosine similarity for every candidate under one weight set.

    The search multiplies each block by its weight and takes one cosine over
    the concatenation.  Because a weight scales its whole block uniformly,
    that cosine separates into per-block terms:

        cos(w) = sum_b w_b^2 d_b / sqrt(sum_b w_b^2 |q_b|^2)
                                 / sqrt(sum_b w_b^2 |c_b|^2)

    so the per-block dot products and norms can be computed once and any
    weight set scored from them.  This is an identity, not an approximation:
    the value here is exactly what `find_similar_windows` would report for the
    same weights, which is what lets the fit optimise the real objective
    rather than a stand-in for it.
    """

    squared = np.square(weights)
    numerator = dots @ squared
    query_part = float(np.sqrt(query_norms @ squared))
    candidate_part = np.sqrt(candidate_norms @ squared)
    denominator = query_part * candidate_part
    return np.divide(
        numerator,
        denominator,
        out=np.zeros_like(numerator),
        where=denominator > 1e-12,
    )


def block_projections(
    query_blocks: dict[str, np.ndarray],
    candidate_blocks: dict[str, np.ndarray],
    block_names: list[str],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-block dot products and squared norms, computed once.

    Everything :func:`similarity_for_weights` needs to score any weight set
    without touching the feature arrays again. Returns ``(dots, query_norms,
    candidate_norms)`` shaped ``(n, b)``, ``(b,)`` and ``(n, b)``.
    """

    dots = np.zeros((next(iter(candidate_blocks.values())).shape[0], len(block_names)))
    query_norms = np.zeros(len(block_names))
    candidate_norms = np.zeros_like(dots)

    for index, name in enumerate(block_names):
        query = np.asarray(query_blocks[name]).reshape(-1)
        candidates = np.asarray(candidate_blocks[name])
        dots[:, index] = candidates @ query
        query_norms[index] = float(query @ query)
        candidate_norms[:, index] = np.einsum("ij,ij->i", candidates, candidates)

    return dots, query_norms, candidate_norms


def _score(
    similarity: np.ndarray, outcomes: np.ndarray, top_k: int
) -> float:
    """Mean outcome of the ``top_k`` most similar windows.

    Deliberately the same quantity the tool reports: it takes the most similar
    windows and trades them, so the weights are fitted to that and not to a
    correlation the user never sees.  Ties in similarity are broken by index,
    which numpy's sort does stably, so the score cannot wobble between runs.
    """

    if similarity.size == 0:
        return 0.0
    take = min(top_k, similarity.size)
    # Sort descending by similarity, stable, then average the leaders.
    order = np.argsort(-similarity, kind="stable")[:take]
    return float(np.mean(outcomes[order]))


def score_weights(
    *,
    block_names: list[str],
    projection: tuple[np.ndarray, np.ndarray, np.ndarray],
    outcomes: np.ndarray,
    top_k: int,
):
    """A function scoring any weight set against one set of labelled windows.

    Used for the holdout, where two weight sets -- the fitted one and the
    hand-set one -- have to be measured the same way on the same windows for
    the comparison to mean anything.
    """

    dots, query_norms, candidate_norms = projection

    def score(weights: dict[str, float]) -> float:
        vector = np.array([weights.get(name, 0.0) for name in block_names], dtype=np.float64)
        if not np.any(vector > 0):
            return float("-inf")
        similarity = similarity_for_weights(dots, query_norms, candidate_norms, vector)
        return _score(similarity, outcomes, top_k)

    return score


def fit_block_weights(
    *,
    block_names: list[str],
    dots: np.ndarray,
    query_norms: np.ndarray,
    candidate_norms: np.ndarray,
    outcomes: np.ndarray,
    starting_weights: dict[str, float],
    top_k: int,
    objective: str = "expectancy",
) -> LearnedWeights:
    """Choose block weights that made the most similar windows pay best.

    ``dots`` is ``(n_candidates, n_blocks)`` of per-block dot products against
    the query, ``candidate_norms`` the matching squared norms, and ``outcomes``
    the realised net return of the trade each candidate would have produced.

    Coordinate ascent over :data:`WEIGHT_GRID`: each block in turn is set to
    whichever grid value scores best with the others held still, repeated
    until a full pass changes nothing.  It is a local search and makes no
    claim to find the global best set -- with an objective this noisy, a
    search that tried harder would mostly be fitting the noise harder.
    """

    if dots.size == 0 or outcomes.size == 0:
        return LearnedWeights(
            weights=dict(starting_weights),
            train_score=0.0,
            default_score=0.0,
            labelled_windows=0,
            top_k=top_k,
            passes=0,
            objective=objective,
        )

    current = np.array([starting_weights[name] for name in block_names], dtype=np.float64)

    def score_of(vector: np.ndarray) -> float:
        if not np.any(vector > 0):
            # Every block switched off leaves no similarity to rank by. Never
            # a real answer, so it is scored out of contention rather than
            # allowed to win by dividing by zero.
            return float("-inf")
        similarity = similarity_for_weights(dots, query_norms, candidate_norms, vector)
        return _score(similarity, outcomes, top_k)

    default_score = score_of(current)
    best_score = default_score
    passes = 0

    for pass_index in range(MAX_PASSES):
        improved = False
        # Fixed block order, so two runs make the same moves in the same
        # sequence and land on the same weights.
        for position in range(len(block_names)):
            incumbent = current[position]
            chosen = incumbent
            for value in WEIGHT_GRID:
                if value == incumbent:
                    continue
                trial = current.copy()
                trial[position] = value
                trial_score = score_of(trial)
                # Strictly better, so a tie keeps the incumbent and the walk
                # cannot oscillate between equal-scoring sets.
                if trial_score > best_score + MIN_IMPROVEMENT:
                    best_score = trial_score
                    chosen = value
                    improved = True
            current[position] = chosen
        passes = pass_index + 1
        if not improved:
            break

    weights = {name: float(current[index]) for index, name in enumerate(block_names)}
    dropped = [name for name, value in weights.items() if value == 0.0]
    if dropped:
        logger.info("Weight fit switched off blocks: %s", ", ".join(dropped))

    return LearnedWeights(
        weights=weights,
        train_score=round(best_score, 6),
        default_score=round(default_score, 6),
        labelled_windows=int(outcomes.size),
        top_k=top_k,
        passes=passes,
        objective=objective,
        dropped_blocks=dropped,
    )
