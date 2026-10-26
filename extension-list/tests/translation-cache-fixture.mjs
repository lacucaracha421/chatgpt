const prefix = 'lakomics:translation-cache:v4:';

export function memoryCache(initial = {}) {
  const cache = structuredClone(initial), reads = [], writes = [];
  return {
    cache, reads, writes,
    async read(index) { reads.push(index); return structuredClone(cache[prefix + index]); },
    async write(shards) {
      writes.push(structuredClone(shards));
      for (const [index, entries] of shards) cache[prefix + index] = structuredClone(entries);
    },
    async clear() { for (const key of Object.keys(cache)) delete cache[key]; },
  };
}
