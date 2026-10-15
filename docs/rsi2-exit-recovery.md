# RSI2 exit execution recovery

The October 15, 2026 log contains six failed managed liquidations with
`insufficient qty available for order` (September 4–28). Protective orders
reserved the shares: `cancel_orders` was sent to the single-position endpoint,
which does not provide that cancellation option. These failures establish an
execution defect; they do not establish the strategy's expected profitability.

The broker adapter now cancels this symbol's open orders, confirms they are
absent, and only then requests liquidation. Pending cancellation blocks the
close. An existing market sell also blocks another close. Cancellation and
liquidation remain separate broker operations: inspect/repair protection if a
liquidation fails after cancellation. The patch has not been tested against a
credentialed Alpaca account.

Managed exits retain the returned order id. Later passes wait for working
orders and retry terminal exits when shares remain. Historical TP/SL touches
cannot suppress native/time exits for a still-held target-strategy position.
RSI2 stop distances, entry rules, and portfolio halt thresholds are unchanged.

Realized results now require broker fills. Model prices remain diagnostic.
Closed legacy model-priced trades are rechecked using fill history when the
normal realization scan reaches them. Original realization timestamps are
preserved. Legacy `exit_submitted` records with no exit id need operator review
of Alpaca open orders before recovery; the worker logs them rather than risking
an additional sale. Older trades outside the 45-day scan require a separate
explicit audit; this patch is not a full historical account reconciliation.

## Deployment and verification

1. Merge the reviewed change into the branch currently checked out on the VM.
   Swing's Telegram bot deploys that branch; it does not select a branch by name.
2. Send `/deploy check`, then `/deploy CONFIRM`. Deploy runs the repository tests.
3. Send `/health`, `/positions`, `/errors` and `/validate` to check runtime state.
   Inspect the next maintenance log: an exit submission must have a broker order
   id, and realized P&L must follow its actual fill, not its model price.
4. Inspect any legacy exit records mentioned above against Alpaca's positions
   and open orders before clearing/retrying them. Do not reset the drawdown halt
   merely to resume entries: the log reported a 10.5% drawdown on October 15.

The added Firestore index eliminates the realization scan's logged missing-index
fallback. Telegram deploy does not deploy indexes. Separately run
`firebase deploy --only firestore:indexes` with the existing authorized Firebase
project configuration, and wait for the index to finish building. Runtime
fallback remains available until then.

Validation: `npm test`, `npm run build`, and `git diff --check`. Regression tests
cover reservation release, pending cancellation, duplicate market exits,
retrying canceled exits, historical stop touches, dry-run behavior, partial
fills, and correction of legacy model-priced results. No live orders were sent.
