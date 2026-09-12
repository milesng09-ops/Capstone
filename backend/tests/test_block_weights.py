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
import pytest

from app.learning.block_weights import (
    GROUP_GRID,
    WEIGHT_GRID,
    expand_group_weights,
    fit_group_weights,
    block_projections,
    fit_block_weights,
    multi_block_projections,
    score_weights,
    similarity_for_weights,
)
from app.services.pattern_service import (
    BLOCK_GROUPS,
    BLOCK_WEIGHTS,
    GROUP_ORDER,
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

    def test_only_a_judged_verdict_counts_as_generalising(self):
        """The raw comparison is not the answer.

        A margin smaller than its own error bar is the same model with noise
        on it. Reading `holdout_score > holdout_default_score` would call that
        a win, which is the overclaiming this project refuses everywhere else.
        """

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

        hurt = replace(fitted, holdout_verdict="worse")
        assert hurt.generalised is False

        won = replace(fitted, holdout_verdict="better")
        assert won.generalised is True

        # Ahead on the raw numbers, inside the noise on the margin: not a win.
        noise = replace(
            fitted,
            holdout_score=0.407,
            holdout_default_score=0.403,
            holdout_verdict="indistinguishable",
        )
        assert noise.holdout_score > noise.holdout_default_score
        assert noise.generalised is False


# --------------------------------------------------------------------------
# Asking the question from many windows instead of one
# --------------------------------------------------------------------------
def multi_setup(queries: int = 12, candidates: int = 50, seed: int = 0):
    query = build_block_matrices(*windows(queries, seed=seed + 500))
    candidate = build_block_matrices(*windows(candidates, seed=seed))
    names = list(query)
    return names, multi_block_projections(query, candidate, names)


class TestManyQueriesAtOnce:
    def test_the_projection_is_shaped_per_query(self):
        names, (dots, query_norms, candidate_norms) = multi_setup(
            queries=12, candidates=50
        )
        assert dots.shape == (12, 50, len(names))
        assert query_norms.shape == (12, len(names))
        assert candidate_norms.shape == (50, len(names))

    def test_similarity_comes_back_one_row_per_query(self):
        names, projection = multi_setup(queries=12, candidates=50)
        vector = np.array([BLOCK_WEIGHTS[name] for name in names])
        assert similarity_for_weights(*projection, vector).shape == (12, 50)

    def test_one_query_still_gives_a_flat_ranking(self):
        # The single-query path has to keep working; the service uses it for
        # the narrower fit that is kept for comparison.
        names, _, _, projection = setup(count=50)
        vector = np.array([BLOCK_WEIGHTS[name] for name in names])
        assert similarity_for_weights(*projection, vector).shape == (50,)

    def test_each_query_is_scored_on_its_own_before_averaging(self):
        """Pooling every pair would let one lucky neighbourhood carry it.

        Averaging per query asks whether the weights make similarity
        predictive generally, which is the question worth an answer.
        """

        names, projection = multi_setup(queries=4, candidates=40, seed=2)
        outcomes = np.zeros(40)
        # One query's best neighbours are wildly profitable; the rest flat.
        vector = np.array([BLOCK_WEIGHTS[name] for name in names])
        similarity = similarity_for_weights(*projection, vector)
        best_of_first = np.argsort(-similarity[0])[:5]
        outcomes[best_of_first] = 100.0

        score = score_weights(
            block_names=names, projection=projection, outcomes=outcomes, top_k=5
        )
        weights = {name: BLOCK_WEIGHTS[name] for name in names}
        # A quarter of the queries seeing +100 each cannot read as +100.
        assert score(weights) < 100.0


class TestAWindowMayNotPredictItself:
    def test_the_mask_removes_self_and_shifted_copies(self):
        """The most complete leakage available here.

        A window is its own nearest neighbour and its shifted copies are next,
        all with near-identical outcomes. Unmasked, the fit is rewarded for
        predicting a window from itself and the result looks spectacular.
        """

        window_length = 20
        queries = [100, 300]
        candidates = [90, 100, 110, 300, 500]
        mask = np.abs(
            np.array(queries)[:, None] - np.array(candidates)[None, :]
        ) >= window_length

        # 90 and 110 are within 20 bars of query 100, so they overlap it.
        assert mask[0].tolist() == [False, False, False, True, True]
        # Query 300 overlaps only the candidate at 300.
        assert mask[1].tolist() == [True, True, True, False, True]

    def test_a_masked_candidate_never_reaches_the_top_k(self):
        names, projection = multi_setup(queries=3, candidates=30, seed=4)
        outcomes = np.zeros(30)
        outcomes[0] = 1000.0  # would dominate any ranking it entered

        mask = np.ones((3, 30), dtype=bool)
        mask[:, 0] = False

        score = score_weights(
            block_names=names,
            projection=projection,
            outcomes=outcomes,
            top_k=5,
            valid_mask=mask,
        )
        weights = {name: BLOCK_WEIGHTS[name] for name in names}
        assert score(weights) == 0.0

    def test_a_query_with_nothing_left_does_not_count_as_neutral(self):
        """An all-masked row has no opinion, and must not be read as zero.

        Counting it as 0.0 would pull the average toward neutral and make a
        weight set look steadier than the evidence supports.
        """

        names, projection = multi_setup(queries=2, candidates=20, seed=6)
        outcomes = np.full(20, -5.0)
        mask = np.ones((2, 20), dtype=bool)
        mask[1, :] = False  # second query has no eligible candidates at all

        score = score_weights(
            block_names=names,
            projection=projection,
            outcomes=outcomes,
            top_k=5,
            valid_mask=mask,
        )
        weights = {name: BLOCK_WEIGHTS[name] for name in names}
        # Only the first query speaks, and it says -5.
        assert score(weights) == pytest.approx(-5.0)


class TestQuerySelectionIsReproducible:
    def test_even_spacing_covers_the_stretch_without_a_seed(self):
        # Mirrors the service's `pick_queries`: coverage of the period, and an
        # even walk needs no seed to repeat.
        starts = list(range(0, 1000))

        def pick(wanted: int) -> list[int]:
            wanted = min(wanted, len(starts))
            if wanted <= 1:
                return starts[:wanted]
            step = (len(starts) - 1) / (wanted - 1)
            return [starts[int(round(index * step))] for index in range(wanted)]

        # 999/4 = 249.75 a step, so the interior points land on the nearest
        # index rather than a round number -- even spacing, not tidy spacing.
        assert pick(5) == [0, 250, 500, 749, 999]
        assert pick(5) == pick(5)
        assert pick(1) == [0]
        assert len(pick(2000)) == 1000


# --------------------------------------------------------------------------
# Three parameters instead of seven
# --------------------------------------------------------------------------
class TestGroupsCoverTheBlocksTheyClaimTo:
    def test_every_block_belongs_to_exactly_one_group(self):
        # A block with no group would silently vanish from the coarse model.
        assert set(BLOCK_GROUPS) == set(BLOCK_WEIGHTS)
        assert set(BLOCK_GROUPS.values()) == set(GROUP_ORDER)

    def test_all_groups_at_one_reproduces_the_hand_set_weights(self):
        """The property that makes the coarse fit start from the status quo.

        Not merely close to it: exactly it, so the incumbent the search has to
        beat is the model already in use.
        """

        expanded = expand_group_weights(
            {group: 1.0 for group in GROUP_ORDER}, BLOCK_GROUPS, BLOCK_WEIGHTS
        )
        assert expanded == BLOCK_WEIGHTS

    def test_a_group_at_zero_switches_off_everything_under_it(self):
        expanded = expand_group_weights(
            {"path": 0.0, "candle": 1.0, "context": 1.0}, BLOCK_GROUPS, BLOCK_WEIGHTS
        )
        assert expanded["normalised_close"] == 0.0
        assert expanded["returns"] == 0.0
        assert expanded["body"] == BLOCK_WEIGHTS["body"]

    def test_blocks_keep_their_relative_standing_inside_a_group(self):
        # Only the balance *between* groups is fitted; within one the hand-set
        # ratios are left alone.
        expanded = expand_group_weights(
            {"path": 0.5, "candle": 0.5, "context": 0.5}, BLOCK_GROUPS, BLOCK_WEIGHTS
        )
        assert expanded["body"] / expanded["upper_wick"] == (
            BLOCK_WEIGHTS["body"] / BLOCK_WEIGHTS["upper_wick"]
        )


def group_fit(outcomes, names, projection, **kw):
    return fit_group_weights(
        block_names=names,
        groups=BLOCK_GROUPS,
        group_order=GROUP_ORDER,
        dots=projection[0],
        query_norms=projection[1],
        candidate_norms=projection[2],
        outcomes=outcomes,
        starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
        top_k=10,
        **kw,
    )


class TestTheCoarseFitSearchesTheWholeSpace:
    def test_it_says_so_rather_than_claiming_a_local_peak(self):
        """Three parameters on a six-value grid is 216 sets.

        Small enough to enumerate, which is the one thing the block-level fit
        cannot claim: coordinate ascent finds *a* peak and cannot say whether
        it found *the* peak.
        """

        names, _, _, projection = setup()
        outcomes = np.random.default_rng(20).normal(size=projection[0].shape[0])
        fitted = group_fit(outcomes, names, projection)
        assert fitted.exhaustive is True
        assert len(GROUP_GRID) ** 3 == 216

    def test_it_reports_the_three_numbers_it_actually_searched(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(21).normal(size=projection[0].shape[0])
        fitted = group_fit(outcomes, names, projection)
        assert set(fitted.group_weights or {}) == set(GROUP_ORDER)
        for value in (fitted.group_weights or {}).values():
            assert value in GROUP_GRID

    def test_the_same_inputs_give_the_same_groups(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(22).normal(size=projection[0].shape[0])
        assert (
            group_fit(outcomes, names, projection).group_weights
            == group_fit(outcomes, names, projection).group_weights
        )

    def test_a_tie_leaves_the_hand_set_model_in_place(self):
        """Flat outcomes mean every weight set scores identically.

        The answer then has to be the incumbent, not whichever combination the
        enumeration happened to reach last.
        """

        names, _, _, projection = setup()
        flat = np.zeros(projection[0].shape[0])
        fitted = group_fit(flat, names, projection)
        assert fitted.group_weights == {group: 1.0 for group in GROUP_ORDER}
        assert fitted.weights == {name: BLOCK_WEIGHTS[name] for name in names}

    def test_it_never_returns_an_all_zero_model(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(23).normal(size=projection[0].shape[0])
        fitted = group_fit(outcomes, names, projection)
        assert any(value > 0 for value in fitted.weights.values())

    def test_it_can_never_end_below_the_hand_set_model(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(24).normal(size=projection[0].shape[0])
        fitted = group_fit(outcomes, names, projection)
        assert fitted.train_score >= fitted.default_score

    def test_nothing_to_learn_from_leaves_the_defaults_alone(self):
        names = list(BLOCK_WEIGHTS)
        fitted = fit_group_weights(
            block_names=names,
            groups=BLOCK_GROUPS,
            group_order=GROUP_ORDER,
            dots=np.zeros((0, len(names))),
            query_norms=np.zeros(len(names)),
            candidate_norms=np.zeros((0, len(names))),
            outcomes=np.zeros(0),
            starting_weights=BLOCK_WEIGHTS,
            top_k=10,
        )
        assert fitted.weights == BLOCK_WEIGHTS
        assert fitted.labelled_windows == 0


class TestTheObjectiveIsCarriedNotAssumed:
    def test_a_binary_outcome_scores_as_a_rate(self):
        """Win rate is the same machinery with a different label.

        Nothing in the fit changes: outcomes arrive as 1.0 for a trade that
        finished up and 0.0 otherwise, so the score is a fraction rather than
        a return, and magnitude leaves the objective entirely.
        """

        names, _, _, projection = setup(count=60)
        rng = np.random.default_rng(30)
        wins = (rng.random(projection[0].shape[0]) > 0.5).astype(float)
        fitted = fit_group_weights(
            block_names=names,
            groups=BLOCK_GROUPS,
            group_order=GROUP_ORDER,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=wins,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
            objective="win_rate",
        )
        assert fitted.objective == "win_rate"
        assert 0.0 <= fitted.train_score <= 1.0
        assert 0.0 <= fitted.default_score <= 1.0

    def test_the_reported_objective_is_whatever_was_asked_for(self):
        names, _, _, projection = setup()
        outcomes = np.random.default_rng(31).normal(size=projection[0].shape[0])
        fitted = fit_block_weights(
            block_names=names,
            dots=projection[0],
            query_norms=projection[1],
            candidate_norms=projection[2],
            outcomes=outcomes,
            starting_weights={name: BLOCK_WEIGHTS[name] for name in names},
            top_k=10,
            objective="win_rate",
        )
        assert fitted.objective == "win_rate"


class TestJudgingTheMarginAgainstItsOwnNoise:
    """The banner that read a 0.004 margin on a 0.40 base as a clean win."""

    def build(self, learned_extra: float, spread: float, queries: int = 40):
        """Two weight sets whose per-query difference has a known mean/spread.

        Built directly rather than fitted, so the verdict is tested against
        numbers chosen for the purpose instead of whatever a fit happened to
        produce.
        """

        rng = np.random.default_rng(77)
        names, projection = multi_setup(queries=queries, candidates=60, seed=8)
        return names, projection, rng, learned_extra, spread

    def verdict_for(self, margin: float, spread: float, queries: int = 60) -> str:
        """Run the real comparison over synthetic paired differences."""

        from app.learning.block_weights import MARGIN_SIGMAS

        rng = np.random.default_rng(5)
        differences = rng.normal(margin, spread, size=queries)
        # Mirror `compare_on_holdout`'s own arithmetic on the differences.
        mean = float(np.mean(differences))
        stderr = float(np.std(differences, ddof=1) / np.sqrt(differences.size))
        if mean > MARGIN_SIGMAS * stderr:
            return "better"
        if mean < -MARGIN_SIGMAS * stderr:
            return "worse"
        return "indistinguishable"

    def test_a_margin_inside_the_noise_is_not_a_win(self):
        # The real case: +0.004 with per-query spread an order larger.
        assert self.verdict_for(margin=0.004, spread=0.08) == "indistinguishable"

    def test_a_margin_clear_of_the_noise_is(self):
        assert self.verdict_for(margin=0.05, spread=0.02) == "better"

    def test_a_loss_clear_of_the_noise_says_so(self):
        assert self.verdict_for(margin=-0.05, spread=0.02) == "worse"

    def test_the_same_margin_can_go_either_way_on_its_spread(self):
        """Which is the whole point: the margin alone cannot be read."""

        assert self.verdict_for(margin=0.03, spread=0.005) == "better"
        assert self.verdict_for(margin=0.03, spread=0.30) == "indistinguishable"


class TestTheComparisonItself:
    def test_it_scores_both_sets_on_the_same_queries(self):
        from app.learning.block_weights import compare_on_holdout

        names, projection = multi_setup(queries=30, candidates=60, seed=9)
        # Sized by candidates, not queries: `dots` is (queries, candidates, blocks).
        outcomes = np.random.default_rng(13).normal(size=projection[0].shape[1])
        defaults = {name: BLOCK_WEIGHTS[name] for name in names}

        same = compare_on_holdout(
            block_names=names,
            projection=projection,
            outcomes=outcomes,
            top_k=10,
            learned_weights=defaults,
            default_weights=defaults,
        )
        # Identical weights: no margin, and nothing to separate.
        assert same.margin == 0.0
        assert same.verdict == "indistinguishable"
        assert same.separated is False

    def test_a_single_query_cannot_establish_a_difference(self):
        """One number has no spread, so nothing can be called separated."""

        from app.learning.block_weights import compare_on_holdout

        names, projection = multi_setup(queries=1, candidates=60, seed=10)
        outcomes = np.random.default_rng(14).normal(size=projection[0].shape[1])
        defaults = {name: BLOCK_WEIGHTS[name] for name in names}
        result = compare_on_holdout(
            block_names=names,
            projection=projection,
            outcomes=outcomes,
            top_k=10,
            learned_weights={**defaults, "returns": 0.0},
            default_weights=defaults,
        )
        assert result.verdict == "indistinguishable"
        assert result.margin_stderr == 0.0
