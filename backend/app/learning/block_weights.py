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
from itertools import product

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

#: Values a *group* weight may take. Wider at the top than `WEIGHT_GRID`
#: because a group multiplies the hand-set weights under it: 1.0 leaves a
#: group as it was, and above 1.0 is how the fit says one matters more than
#: the hand-set numbers allowed.
GROUP_GRID: tuple[float, ...] = (0.0, 0.25, 0.5, 0.75, 1.0, 1.5)


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
    #: Windows used as queries. One means the fit saw a single neighbourhood.
    query_windows: int = 1
    #: Set when the coarse model was fitted: the three numbers actually
    #: searched over, before being expanded onto the blocks.
    group_weights: dict[str, float] | None = None
    #: True when the whole weight space was enumerated rather than walked.
    exhaustive: bool = False
    #: Blocks the fit switched off entirely, named for the notes.
    dropped_blocks: list[str] = field(default_factory=list)

    #: The same objective on windows the fit never saw, for the learned set
    #: and for the hand-set one. `None` when the holdout was too small to
    #: score, which is itself worth reporting rather than papering over.
    holdout_score: float | None = None
    holdout_default_score: float | None = None
    holdout_windows: int = 0
    #: Mean per-query margin over the hand-set weights, and its uncertainty.
    holdout_margin: float | None = None
    holdout_margin_stderr: float | None = None
    #: "better" | "indistinguishable" | "worse". `None` when there was no
    #: holdout to judge on.
    holdout_verdict: str | None = None

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
        """Whether the fit is *demonstrably* better on data it never saw.

        Not the raw comparison. A margin smaller than its own uncertainty is
        the same model with noise on it, and answering "yes" to that would
        overclaim in exactly the way this project refuses everywhere else --
        so only a verdict of "better" counts. ``None`` means nothing was
        measured, which is different from measuring no difference.
        """

        if self.holdout_verdict is None:
            return None
        return self.holdout_verdict == "better"


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
    query_part = np.sqrt(np.atleast_1d(query_norms @ squared))
    candidate_part = np.sqrt(candidate_norms @ squared)
    # One query gives (n,); many give (m, n) -- the outer product of the two
    # norm vectors, which broadcasting produces without a special case.
    denominator = (
        query_part[:, None] * candidate_part[None, :]
        if numerator.ndim == 2
        else query_part[0] * candidate_part
    )
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


def multi_block_projections(
    query_blocks: dict[str, np.ndarray],
    candidate_blocks: dict[str, np.ndarray],
    block_names: list[str],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The same projections for many queries at once.

    ``dots`` comes back ``(queries, candidates, blocks)``, query norms
    ``(queries, blocks)`` and candidate norms ``(candidates, blocks)``.  Built
    once so the weight search is a handful of matrix products per trial rather
    than a pass over the feature arrays.
    """

    first_query = next(iter(query_blocks.values()))
    first_candidate = next(iter(candidate_blocks.values()))
    queries, candidates = first_query.shape[0], first_candidate.shape[0]

    dots = np.zeros((queries, candidates, len(block_names)))
    query_norms = np.zeros((queries, len(block_names)))
    candidate_norms = np.zeros((candidates, len(block_names)))

    for index, name in enumerate(block_names):
        q = np.asarray(query_blocks[name])
        c = np.asarray(candidate_blocks[name])
        dots[:, :, index] = q @ c.T
        query_norms[:, index] = np.einsum("ij,ij->i", q, q)
        candidate_norms[:, index] = np.einsum("ij,ij->i", c, c)

    return dots, query_norms, candidate_norms


def _per_query(
    similarity: np.ndarray, outcomes: np.ndarray, top_k: int
) -> np.ndarray:
    """Each query's own score: the mean outcome of its ``top_k`` neighbours.

    Deliberately the same quantity the tool reports: it takes the most similar
    windows and trades them, so the weights are fitted to that and not to a
    correlation the user never sees.  Ties are broken by index, which numpy's
    stable sort does deterministically, so the score cannot wobble between
    runs.

    Kept per query rather than reduced immediately, because two weight sets
    are compared on the *same* queries and the comparison is far tighter done
    pair by pair than between two independently averaged numbers.

    ``NaN`` marks a query whose candidates were all masked out: it has nothing
    to say, and counting it as zero would drag the average toward a neutral
    result nobody measured.
    """

    if similarity.size == 0:
        return np.zeros(0)

    matrix = similarity if similarity.ndim == 2 else similarity[None, :]
    take = min(top_k, matrix.shape[1])
    if take <= 0:
        return np.zeros(0)

    order = np.argsort(-matrix, axis=1, kind="stable")[:, :take]
    picked = outcomes[order]
    return np.where(
        np.isneginf(np.take_along_axis(matrix, order, axis=1)).all(axis=1),
        np.nan,
        picked.mean(axis=1),
    )


def _score(
    similarity: np.ndarray, outcomes: np.ndarray, top_k: int
) -> float:
    """One number for a weight set: the mean of the per-query scores.

    With many queries each is scored on its own and the results averaged,
    rather than pooling every (query, candidate) pair.  Pooling would let a
    single query with unusually good neighbours carry the objective; averaging
    per query asks the question that actually matters -- does this weight set
    make similarity predictive *generally*, not just around one window.
    """

    per_query = _per_query(similarity, outcomes, top_k)
    if per_query.size == 0 or np.all(np.isnan(per_query)):
        return 0.0
    return float(np.nanmean(per_query))


def _masked(similarity: np.ndarray, valid_mask: np.ndarray | None) -> np.ndarray:
    """Put ineligible candidates out of reach of the top-k.

    A query's own window, and every window overlapping it, would otherwise sit
    at the top of its own ranking with an outcome all but identical to its
    own. The fit would then be rewarding weights for predicting a window from
    itself, which is the most complete form of leakage available here and
    would look like a spectacular result.
    """

    if valid_mask is None:
        return similarity
    return np.where(valid_mask, similarity, -np.inf)


def score_weights(
    *,
    block_names: list[str],
    projection: tuple[np.ndarray, np.ndarray, np.ndarray],
    outcomes: np.ndarray,
    top_k: int,
    valid_mask: np.ndarray | None = None,
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
        return _score(_masked(similarity, valid_mask), outcomes, top_k)

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
    valid_mask: np.ndarray | None = None,
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
        return _score(_masked(similarity, valid_mask), outcomes, top_k)

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
        query_windows=int(dots.shape[0]) if dots.ndim == 3 else 1,
        top_k=top_k,
        passes=passes,
        objective=objective,
        dropped_blocks=dropped,
    )


def expand_group_weights(
    group_weights: dict[str, float],
    groups: dict[str, str],
    defaults: dict[str, float],
) -> dict[str, float]:
    """Turn three group numbers into the seven block weights the search uses.

    A group multiplies the hand-set weights inside it, so the blocks keep
    their relative standing and only the balance *between* groups is fitted.
    All groups at 1.0 reproduces the hand-set set exactly.
    """

    return {
        name: group_weights[groups[name]] * default
        for name, default in defaults.items()
    }


def fit_group_weights(
    *,
    block_names: list[str],
    groups: dict[str, str],
    group_order: tuple[str, ...],
    dots: np.ndarray,
    query_norms: np.ndarray,
    candidate_norms: np.ndarray,
    outcomes: np.ndarray,
    starting_weights: dict[str, float],
    top_k: int,
    objective: str = "expectancy",
    valid_mask: np.ndarray | None = None,
) -> LearnedWeights:
    """Fit one weight per group, by enumerating every combination.

    Three parameters on a six-value grid is 216 combinations, so the whole
    space is searched rather than walked.  That removes the caveat the
    block-level fit has to carry -- coordinate ascent finds *a* peak and
    cannot say whether it found *the* peak -- and here the answer is simply
    the best set there is.

    Fewer parameters is the point, not a simplification for speed.  Seven
    weights against an objective read off a few dozen trades per query is
    enough freedom to fit the noise; three is a coarser instrument, and a
    coarser instrument is what a noisy measurement deserves.
    """

    present = [group for group in group_order if any(groups[name] == group for name in block_names)]
    defaults = {name: starting_weights[name] for name in block_names}

    def score_of(group_weights: dict[str, float]) -> float:
        expanded = expand_group_weights(group_weights, groups, defaults)
        vector = np.array([expanded[name] for name in block_names], dtype=np.float64)
        if not np.any(vector > 0):
            return float("-inf")
        similarity = similarity_for_weights(dots, query_norms, candidate_norms, vector)
        return _score(_masked(similarity, valid_mask), outcomes, top_k)

    if dots.size == 0 or outcomes.size == 0:
        return LearnedWeights(
            weights=dict(defaults),
            train_score=0.0,
            default_score=0.0,
            labelled_windows=0,
            top_k=top_k,
            passes=0,
            objective=objective,
            group_weights={group: 1.0 for group in present},
            exhaustive=True,
        )

    # All groups at 1.0 is the hand-set model, and the incumbent to beat.
    incumbent = {group: 1.0 for group in present}
    default_score = score_of(incumbent)
    best, best_score = incumbent, default_score

    for combination in product(GROUP_GRID, repeat=len(present)):
        trial = dict(zip(present, combination))
        # Strictly better, so the hand-set model keeps the tie and the answer
        # does not depend on enumeration order.
        trial_score = score_of(trial)
        if trial_score > best_score + MIN_IMPROVEMENT:
            best, best_score = trial, trial_score

    weights = expand_group_weights(best, groups, defaults)
    dropped = [name for name, value in weights.items() if value == 0.0]

    return LearnedWeights(
        weights=weights,
        train_score=round(best_score, 6),
        default_score=round(default_score, 6),
        labelled_windows=int(outcomes.size),
        query_windows=int(dots.shape[0]) if dots.ndim == 3 else 1,
        top_k=top_k,
        passes=1,
        objective=objective,
        dropped_blocks=dropped,
        group_weights={group: float(value) for group, value in best.items()},
        exhaustive=True,
    )


@dataclass(frozen=True)
class HoldoutComparison:
    """Two weight sets measured against each other on unseen windows.

    The margin alone cannot be read.  A fit beating the hand-set weights by
    0.004 on a base of 0.40 is not a better model, it is the same model with
    noise on top -- and rendering that as a win is exactly the overclaiming
    this project refuses everywhere else.  So the margin is reported with the
    uncertainty it carries, and the verdict is drawn from both.
    """

    learned_score: float
    default_score: float
    #: Mean per-query difference, learned minus hand-set.
    margin: float
    #: Standard error of that difference.  Paired: both weight sets are scored
    #: on the same queries, so the per-query differences are what varies, and
    #: their spread is far tighter than that of two separate averages.
    margin_stderr: float
    queries: int
    verdict: str

    @property
    def separated(self) -> bool:
        return self.verdict in {"better", "worse"}


#: Standard errors the margin must clear before the difference is called
#: real.  Two is the usual 95% convention; the point is less the exact number
#: than that there *is* one, so a margin inside the noise reports as
#: "indistinguishable" rather than as a win.
MARGIN_SIGMAS = 2.0


def compare_on_holdout(
    *,
    block_names: list[str],
    projection: tuple[np.ndarray, np.ndarray, np.ndarray],
    outcomes: np.ndarray,
    top_k: int,
    learned_weights: dict[str, float],
    default_weights: dict[str, float],
    valid_mask: np.ndarray | None = None,
) -> HoldoutComparison:
    """Score both weight sets on the same unseen windows and judge the gap."""

    dots, query_norms, candidate_norms = projection

    def per_query(weights: dict[str, float]) -> np.ndarray:
        vector = np.array(
            [weights.get(name, 0.0) for name in block_names], dtype=np.float64
        )
        if not np.any(vector > 0):
            return np.full(dots.shape[0] if dots.ndim == 3 else 1, np.nan)
        similarity = similarity_for_weights(dots, query_norms, candidate_norms, vector)
        return _per_query(_masked(similarity, valid_mask), outcomes, top_k)

    learned = per_query(learned_weights)
    default = per_query(default_weights)

    usable = ~(np.isnan(learned) | np.isnan(default))
    differences = (learned - default)[usable]
    learned_mean = float(np.nanmean(learned)) if learned.size else 0.0
    default_mean = float(np.nanmean(default)) if default.size else 0.0

    if differences.size < 2:
        # One query cannot say how much a difference varies, so nothing here
        # can be called separated from noise.
        margin = float(differences[0]) if differences.size else 0.0
        return HoldoutComparison(
            learned_score=round(learned_mean, 6),
            default_score=round(default_mean, 6),
            margin=round(margin, 6),
            margin_stderr=0.0,
            queries=int(differences.size),
            verdict="indistinguishable",
        )

    margin = float(np.mean(differences))
    stderr = float(np.std(differences, ddof=1) / np.sqrt(differences.size))

    if stderr <= 0.0:
        verdict = "better" if margin > 0 else "worse" if margin < 0 else "indistinguishable"
    elif margin > MARGIN_SIGMAS * stderr:
        verdict = "better"
    elif margin < -MARGIN_SIGMAS * stderr:
        verdict = "worse"
    else:
        verdict = "indistinguishable"

    return HoldoutComparison(
        learned_score=round(learned_mean, 6),
        default_score=round(default_mean, 6),
        margin=round(margin, 6),
        margin_stderr=round(stderr, 6),
        queries=int(differences.size),
        verdict=verdict,
    )
