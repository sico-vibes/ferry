# MAIN-GREEN round 6: don't fix a test by disabling a feature (no commit)

Round 5's root cause is correct (smartReliability samples a Beta posterior with ambient `Math.random`). The fix isn't acceptable: no production caller in `packages/core` passes `ScoreInput.random`, so in the real app Thompson-sampling exploration is now off, and N4 weighted routing with the `() => 0.5` fallback no longer splits traffic by weight. That's a silent product regression.

Required:
1. Production keeps real randomness: the core passes a random source into routing (a default `Math.random`, or a seedable source owned by the core). Weighted share and smartReliability exploration work in the app exactly as before.
2. Determinism lives in the tests: the router test injects a seeded RNG (or uses the mean-mode option explicitly). The "historical deterministic ordering at default knobs" test must pin what "deterministic" means. If default settings include smartReliability sampling, the test either injects a fixed RNG or asserts against the sampling-free path; it must not rely on ambient randomness.
3. If you think smartReliability *shouldn't* sample by default (for example the posterior mean is better for a free-tier router), don't change it here; write the argument into your report and I'll decide.
4. Add a test proving weights still split traffic (for example 3:1 weights over 4,000 seeded picks lands within tolerance), and one proving the core passes a random source.

Keep the timezone and midnight regression. Typecheck, lint and prettier; no commit.
