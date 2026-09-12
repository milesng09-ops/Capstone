"""Fitting the similarity weights, and being able to tell when it found nothing.

Seven free parameters against an objective read off a few dozen trades will
nearly always beat the hand-set numbers on the data it was fitted to. That
fact is why the interesting assertions here are not "the fit improves things"
-- it does, trivially -- but that the fit is reproducible, that it cannot
produce a degenerate answer, and that the holdout comparison is computed the
same way for both weight sets so a fit that hurt cannot report success.
"""

from __future__ import annotations

import numpy as np

from app.learning.block_weights import (
    WEIGHT_GRID,
    block_projections,
    fit_block_weights,
    score_weights,
    similarity_for_weights,
)
from app.services.pattern_service import (
    BLOCK_WEIGHTS,
    build_block_matrices,
    build_feature_matrix,
)

WIDTH = 20


def windows(count: int, seed: int = 0):
    rng = np.random.default_rng(seed)
    opens = rng.random((count, WIDTH)) + 100
    closes = rng.random((count, WIDTH)) + 100
    highs = np.maximum(opens, closes) + rng.random((count, WIDTH))
    lows = np.minimum(opens, closes) - rng.random((count, WIDTH))
    volumes = rng.random((count, WIDTH)) * 1000 + 1
    return opens, highs, lows, closes, volumes


def setup(count: int = 60, seed: int = 0):
    query = build_block_matrices(*windows(1, seed=seed + 99))
    candidates = build_block_matrices(*windows(count, seed=seed))
    names = list(query)
    return names, query, candidates, block_projections(query, candidates, names)


# --------------------------------------------------------------------------
class TestTheDecompositionIsTheSearchsOwnCosine:
    def test_it_reproduces_find_similar_windows_exactly(self):
        """An identity, not an approximation.

        If it were an approximation the fit would be optimising a stand-in for
        the thing the user sees, and the weights it chose would be right for a
        similarity nobody computes.
        """

        query_arrays = windows(1, seed=99)
        candidate_arrays = windows(40, seed=1)
        names, query, candidates, projection = (
            list(build_block_matrices(*query_arrays)),
            build_block_matrices(*query_arrays),
            build_block_matrices(*candidate_arrays),
            None,
        )
        projection = block_projections(query, candidates, names)
        vector = np.array([BLOCK_WEIGHTS[name] for name in names])
        mine = similarity_for_weights(*projection, vector)

        query_vector = build_feature_matrix(*query_arrays)[0]
        matrix = build_feature_matrix(*candidate_arrays)
        theirs = (matrix @ query_vector) / (
            np.linalg.norm(matrix, axis=1) * np.linalg.norm(query_vector)
        )
        assert np.allclose(mine, theirs)

    def test_switching_a_block_off_changes_the_ranking(self):
        names, _, _, projection = setup()
        full = np.array([BLOCK_WEIGHTS[name] for name in names])
        without = full.copy()
        without[names.index("returns")] = 0.0
        assert not np.allclose(
            similarity_for_weights(*projection, full),
            similarity_for_weights(*projection, without),
        )


class TestTheFitIsReproducible:
    def test_the_same_inputs_give_the_same_weights(self):
        # A model that moved between runs could not be reported on, for the
        # same reason the pattern search and the baseline draw are pinned.
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(5).normal(size=projection[0].shape[0])
        defaults = {name: BLOCK_WEIGHTS[name] for name in names}
        kwargs = dict(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights=defaults,
            top_k=10,
        )
        assert fit_block_weights(**kwargs).weights == fit_block_weights(**kwargs).weights

    def test_every_weight_lands_on_the_grid(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(6).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
        )
        for value in fitted.weights.values():
            assert value in WEIGHT_GRID or value in set(BLOCK_WEIGHTS.values())


class TestItCannotProduceANonsenseModel:
    def test_it_never_switches_every_block_off(self):
        """All-zero weights leave no similarity to rank by.

        Scored out of contention rather than allowed to win by dividing by
        zero -- which, with a degenerate denominator, it otherwise could.
        """

        names, _, _, projection = setup()
        outcomes = np.random.default_rng(7).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
        )
        assert any(value > 0 for value in fitted.weights.values())

    def test_nothing_to_learn_from_returns_the_defaults(self):
        defaults = {name: BLOCK_WEIGHTS[name] for name in BLOCK_WEIGHTS}
        fitted = fit_block_weights(
            block_names=list(defaults),
            dots=np.zeros((0, len(defaults))),
            query_norms=np.zeros(len(defaults)),
            candidate_norms=np.zeros((0, len(defaults))),
            outcomes=np.zeros(0),
            starting_weights=defaults,
            top_k=10,
        )
        assert fitted.weights == defaults
        assert fitted.labelled_windows == 0

    def test_it_reports_what_the_defaults_scored_on_the_same_data(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(8).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
        )
        # Coordinate ascent starts from the defaults and only takes strict
        # improvements, so it can never end below where it began.
        assert fitted.train_score >= fitted.default_score
        assert fitted.improved == (fitted.train_score > fitted.default_score)


class TestTheHoldoutDecidesIt:
    def test_both_weight_sets_are_scored_the_same_way(self):
        names, _, _, projection = setup(count=80, seed=3)
        outcomes = np.random.default_rng(9).normal(size=projection[0].shape[0])
        score = score_weights(
            block_names=names, projection=projection, outcomes=outcomes, top_k=15
        )
        defaults = {name: BLOCK_WEIGHTS[name] for name in names}
        # Same function, same windows, same k -- the only difference between
        # the two numbers is the weights, which is what makes them comparable.
        assert score(defaults) == score(dict(defaults))
        assert isinstance(score({**defaults, "returns": 0.0}), float)

    def test_an_all_zero_set_is_scored_out_of_contention(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(10).normal(size=projection[0].shape[0])
        score = score_weights(
            block_names=names, projection=projection, outcomes=outcomes, top_k=10
        )
        assert score({name: 0.0 for name in names}) == float("-inf")

    def test_generalised_is_unknown_without_a_holdout(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(11).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
        )
        # Not False -- unknown. Reporting "did not generalise" when nothing
        # was measured would be as wrong as claiming it did.
        assert fitted.generalised is None

    def test_a_fit_that_hurt_out_of_sample_says_so(self):
        from dataclasses import replace

        names, _, _, projection = setup()
        outcomes = np.random.default_rng(12).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
        )
        hurt = replace(
            fitted, holdout_score=-0.10, holdout_default_score=-0.07, holdout_windows=500
        )
        assert hurt.improved is True or hurt.improved is False  # training verdict
        assert hurt.generalised is False
