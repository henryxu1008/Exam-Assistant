/** Persistent question identities. Called only within the publication transaction. */
const { readOptionalDoc } = require('./db-error.js')
const { sha256, canonical } = require('./question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const bucketOf = id => sha256(id)[0]
const buckets = '0123456789abcdef'.split('')
const questionList = bank => bank ? Object.values(bank.questions).flat() : []
const bytes = value => encodeURIComponent(canonical(value)).replace(/%[A-F0-9]{2}/g, 'x').length

async function checkIdentities(collection, current, next, commit) {
  // A legacy catalog has name-based identities. Its existing records cannot safely be
  // reclassified from aggregate counters; never silently promote it to stable IDs.
  if (current && current.schemaVersion !== 3) fail('LEGACY_IDENTITY_MIGRATION_REQUIRED')
  const markerRef = collection.doc('bank_identity_registry'), marker = await readOptionalDoc(() => markerRef.get())
  const revision = current ? current.publicationRevision : 0
  if ((current && (!marker || marker.kind !== 'questionIdentityRegistry' || marker.version !== 1 || marker.revision !== revision)) ||
      (!current && marker)) fail('IDENTITY_REGISTRY_INVALID')
  const shards = new Map(), all = new Map()
  for (const bucket of buckets) {
    const ref = collection.doc('bank_identity_' + bucket), doc = await readOptionalDoc(() => ref.get())
    const listed = !!(marker && Array.isArray(marker.buckets) && marker.buckets.includes(bucket))
    if (listed !== !!doc) fail('IDENTITY_REGISTRY_INVALID')
    if (doc && (doc.kind !== 'questionIdentityShard' || doc.bucket !== bucket || !doc.entries || typeof doc.entries !== 'object' ||
      Array.isArray(doc.entries) || doc.digest !== sha256(canonical(doc.entries)))) fail('IDENTITY_REGISTRY_INVALID')
    const entries = doc ? doc.entries : {}
    for (const [hash, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.id !== 'string' || sha256(entry.id) !== hash || hash[0] !== bucket ||
          typeof entry.subject !== 'string' || !entry.subject || typeof entry.chapter !== 'string' || !entry.chapter || typeof entry.retired !== 'boolean') fail('IDENTITY_REGISTRY_INVALID')
      all.set(entry.id, entry)
    }
    shards.set(bucket, { ref, entries, existed: !!doc, changed: false })
  }
  if (marker && (!Array.isArray(marker.buckets) || marker.buckets.some(b => !buckets.includes(b)) || new Set(marker.buckets).size !== marker.buckets.length)) fail('IDENTITY_REGISTRY_INVALID')
  const previous = new Map(questionList(current).map(q => [q.id, q])), incoming = new Map(questionList(next).map(q => [q.id, q]))
  for (const [id, entry] of all) {
    const q = previous.get(id)
    if ((!entry.retired && !q) || (q && (entry.retired || q.subject !== entry.subject || q.chapter !== entry.chapter))) fail('IDENTITY_REGISTRY_INVALID')
  }
  for (const id of previous.keys()) if (!all.has(id)) fail('IDENTITY_REGISTRY_INVALID')
  for (const [id, q] of incoming) {
    const entry = all.get(id)
    if (entry && entry.retired) fail('QUESTION_ID_RETIRED')
    if (entry && (entry.subject !== q.subject || entry.chapter !== q.chapter)) fail('QUESTION_SCOPE_IMMUTABLE')
    if (!entry) {
      const shard = shards.get(bucketOf(id)); shard.entries[sha256(id)] = { id, subject: q.subject, chapter: q.chapter, retired: false }; shard.changed = true
    }
  }
  for (const [id] of previous) if (!incoming.has(id)) {
    const shard = shards.get(bucketOf(id)); shard.entries[sha256(id)].retired = true; shard.changed = true
  }
  if (!commit) return
  const present = []
  for (const [bucket, shard] of shards) {
    if (shard.changed) {
      if (bytes(shard.entries) > 750000) fail('IDENTITY_REGISTRY_FULL')
      await shard.ref.set({ data: { kind: 'questionIdentityShard', bucket, entries: shard.entries, digest: sha256(canonical(shard.entries)) } })
    }
    if (shard.existed || shard.changed) present.push(bucket)
  }
  await markerRef.set({ data: { kind: 'questionIdentityRegistry', version: 1, revision: revision + 1, buckets: present } })
}
module.exports = { checkIdentities }
