// =============================================================================
// Count Firestore document reads per run.
//
// Operating on the free tier means operating near a hard limit whose breach
// silently stops the system trading. That is survivable only with visibility:
// "the runners used 180 reads today" is a fact you can budget against, whereas
// an estimate is how a 400,000-read-a-day query went unnoticed until it killed
// three consecutive entry runs.
//
// Billing counts one read per DOCUMENT returned (a query matching nothing still
// bills one), so that is what this counts. It is an approximation of the
// invoice, not the invoice — close enough to spot a runaway query, which is the
// only thing it is for.
//
// Implementation: wrap `get()` on the Query and DocumentReference prototypes,
// reached through real instances rather than by importing internals. The wrapper
// only increments a counter and delegates — it cannot change a result, and any
// failure inside it is swallowed rather than propagated into the money path.
// =============================================================================

let reads = 0;
let queries = 0;
let installed = false;

export function installReadMeter(db) {
  if (installed || !db) return;
  try {
    const q = db.collection('__meter__').limit(1);
    const docRef = db.collection('__meter__').doc('x');
    const QueryProto = Object.getPrototypeOf(q);
    const DocProto = Object.getPrototypeOf(docRef);

    for (const [proto, isQuery] of [[QueryProto, true], [DocProto, false]]) {
      if (!proto || typeof proto.get !== 'function' || proto.__swingMetered) continue;
      const original = proto.get;
      proto.get = async function meteredGet(...args) {
        const res = await original.apply(this, args);
        try {
          if (isQuery) {
            queries++;
            // An empty query still bills one read.
            reads += Math.max(1, res?.size ?? (res?.docs?.length ?? 0));
          } else {
            reads += 1;
          }
        } catch { /* counting must never affect the caller */ }
        return res;
      };
      proto.__swingMetered = true;
    }
    installed = true;
  } catch {
    // Firestore internals differ across versions. Losing the counter is a lost
    // metric; throwing here would be a lost trading run.
  }
}

export const readCount = () => reads;
export const queryCount = () => queries;
export function resetReadMeter() { reads = 0; queries = 0; }

// One line for the end of a run. Includes the daily free-tier ceiling because
// the number is meaningless without it — 900 reads is fine, 9,000 four times a
// day is not.
export function readSummary({ limit = 50_000 } = {}) {
  const pctOfDay = ((reads / limit) * 100).toFixed(1);
  return `firestore: ${reads} document read(s) across ${queries} quer(y|ies) — ${pctOfDay}% of the ${limit.toLocaleString()}/day free tier`;
}
