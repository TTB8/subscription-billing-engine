# Design decisions

Short records of the choices that shape this engine, and why. Each one says what
the alternative was and what it costs, so a reader can disagree with the
reasoning and not just with the result.

| #                                                  | Decision                                                 |
| -------------------------------------------------- | -------------------------------------------------------- |
| [0001](0001-fixed-day-cycles.md)                   | Fixed-day cycles anchored to the first payment           |
| [0002](0002-no-proration.md)                       | No proration: a cycle is the unit of sale                |
| [0003](0003-pure-domain-package.md)                | All billing rules live in a pure domain package          |
| [0004](0004-gateway-interface-and-fake.md)         | The payment provider sits behind an interface, with a fake |
| [0005](0005-derived-idempotency-keys.md)           | Idempotency keys are derived from state, never random    |
| [0006](0006-append-only-ledger.md)                 | An append-only ledger, with guarantees in the database   |
| [0007](0007-webhook-processing.md)                 | Webhooks: atomic deduplication, state from events not order |
| [0008](0008-provider-outcomes.md)                  | Three kinds of provider outcome, three different reactions |
| [0009](0009-integer-money-and-utc.md)              | Integer money and UTC timestamps                         |

Format: context, decision, consequences. New decisions get the next number;
a decision that is replaced is marked as superseded, not edited away.
