"""Suite-wide isolation from the machine the tests run on."""

import os

# The Massive budget survives restarts through a state file under backend/var.
# A developer's own session leaves calls in it, and a test that builds a
# MassiveProvider would then be paced -- or refused -- by requests made from
# the browser an hour earlier. Off for the suite; the tests that need the
# file pass their own path.
os.environ["MASSIVE_QUOTA_STATE_FILE"] = ""
