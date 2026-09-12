"""Phase two: weights fitted to outcomes, not chosen by hand.

The detectors and the similarity search stay rule-based arithmetic.  What is
learned here is narrow and inspectable: how much each feature block counts
toward "these two windows look alike".  Those seven numbers were set by hand;
this package fits them to what actually happened after the matches.

Nothing about the search's definition changes.  A learned set is passed into
`build_feature_matrix` exactly where the hand-set one went, so a match is
still explainable as the same cosine over the same features -- and the model,
in its entirety, is seven numbers anyone can read.
"""

from app.learning.block_weights import LearnedWeights, fit_block_weights

__all__ = ["LearnedWeights", "fit_block_weights"]
