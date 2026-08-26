export class SmoothWeightedRoundRobin {
    constructor() {
        this.entries = new Map();
    }

    setWeight(id, weight) {
        const key = String(id);
        const normalized = Number(weight);
        if (!Number.isFinite(normalized) || normalized <= 0) {
            this.entries.delete(key);
            return;
        }
        const current = this.entries.get(key);
        this.entries.set(key, { weight: normalized, current: current?.current || 0 });
    }

    select(candidateIds = []) {
        const candidateSet = new Set(candidateIds.map(String));
        // Preserve scheduler registration order instead of the caller's
        // candidate ordering (which may be score-sorted on each request).
        const candidates = [...this.entries.keys()]
            .filter(id => candidateSet.has(id));
        if (candidates.length === 0) return null;

        let total = 0;
        let selected = null;
        // Advance only eligible candidates.  This keeps an unavailable entry's
        // accumulated share intact without allowing it to distort the current
        // scheduling window or dilute the eligible pool's total weight.
        for (const id of candidates) {
            const entry = this.entries.get(id);
            entry.current += entry.weight;
            total += entry.weight;
            // Map insertion order is the stable tie-breaker.  Using lexical
            // ordering here can systematically favor IDs such as "high" and
            // skew short windows away from the configured weight ratio.
            if (!selected || entry.current > selected.entry.current) {
                selected = { id, entry };
            }
        }
        selected.entry.current -= total;
        return selected.id;
    }

    clearMissing(ids = []) {
        const keep = new Set(ids.map(String));
        for (const id of this.entries.keys()) {
            if (!keep.has(id)) this.entries.delete(id);
        }
    }
}
