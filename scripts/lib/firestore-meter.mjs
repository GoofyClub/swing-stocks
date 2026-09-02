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
let writes = 0;
let installed = false;

export function installReadMeter(db) {
  if (installed || !db) return;
  try {
    const q = db.collection('__meter__').limit(1);
    const docRef = db.collection('__meter__').doc('x');
    const QueryProto = Object.getPrototypeOf(q);
    const DocProto = Object.getPrototypeOf(docRef);

    // Writes have their own daily ceiling (20k, well under the 50k for reads),
    // and it was a WRITE that hit RESOURCE_EXHAUSTED in the broad refresh —
    // counting only reads meant looking for the problem in the wrong budget.
    for (const m of ['set', 'update', 'create', 'delete']) {
      if (typeof DocProto?.[m] !== 'function' || DocProto[`__swingMetered_${m}`]) continue;
      const original = DocProto[m];
      DocProto[m] = function meteredWrite(...args) {
        try { writes++; } catch { /* never affect the caller */ }
        return original.apply(this, args);
      };
      DocProto[`__swingMetered_${m}`] = true;
    }
    // Batched writes bill per document, and a batch is where the volume hides.
    try {
      const batchProto = Object.getPrototypeOf(db.batch());
      for (const m of ['set', 'update', 'create', 'delete']) {
        if (typeof batchProto?.[m] !== 'function' || batchProto[`__swingMetered_${m}`]) continue;
        const original = batchProto[m];
        batchProto[m] = function meteredBatchWrite(...args) {
          try { writes++; } catch { /* ditto */ }
          return original.apply(this, args);
        };
        batchProto[`__swingMetered_${m}`] = true;
      }
    } catch { /* batches are optional to meter */ }

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
export const writeCount = () => writes;
export function resetReadMeter() { reads = 0; queries = 0; writes = 0; }

// One line for the end of a run. Includes both daily free-tier ceilings because
// the numbers are meaningless without them — 900 reads is fine, 9,000 four times
// a day is not — and because the two budgets differ by more than 2x, so the one
// you are about to exhaust is not always the one you were watching.
export function readSummary({ readLimit = 50_000, writeLimit = 20_000 } = {}) {
  const rPct = ((reads / readLimit) * 100).toFixed(1);
  const wPct = ((writes / writeLimit) * 100).toFixed(1);
  return `firestore: ${reads} read(s) across ${queries} quer(y|ies) — ${rPct}% of ${readLimit.toLocaleString()}/day`
    + ` · ${writes} write(s) — ${wPct}% of ${writeLimit.toLocaleString()}/day`;
}
