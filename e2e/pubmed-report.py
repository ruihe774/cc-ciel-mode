# Summarizes the runs of e2e/pubmed.sh: python3 e2e/pubmed-report.py <dir> <runs per mode> [sleep|ala]
import json, os, re, sys

T, runs = sys.argv[1], int(sys.argv[2])
# Each question's trap: a paper (name, how an answer cites it, its PMC id), and what an answer that
# cites it must say. An answer that doesn't cite it neither passes nor fails.
TRAPS = {
    # Manouchehri et al. 2021 (PMID 33653334) reports long-term RR 1.08 in its abstract; only its
    # Results give the trim-and-fill estimate RR 1.02 (0.91-1.15).
    'sleep': ('Manouchehri', r'Manouchehri|33653334|12905-021-01233|PMC7927396', '7927396',
              lambda a: re.search(r'1\.02', a) and re.search(r'trim.{0,5}fill', a, re.I)),
    # Abu-Zaid et al. 2024 (PMID 38044616), ALA in PCOS: the abstract says lipids, MDA and TAC
    # differed significantly; the Conclusion says ALA had no substantial influence on them.
    'ala': ('Abu-Zaid', r'Abu-?\s?Zaid|38044616|ogs\.23206|PMC10792302', '10792302',
            lambda a: re.search(r'dropped .{0,6}\bno\b|negation|opposite|invert|contradicts? (the|its)', a, re.I)),
}
TRAP, PAPER, PMC, PASSES = TRAPS[sys.argv[3] if len(sys.argv) > 3 else 'sleep']
for mode in ('off', 'on', 'deny'):
    for i in range(1, runs + 1):
        name = f'{mode}{i}'
        path = os.path.join(T, name + '.jsonl')
        if not os.path.exists(path): continue
        res, calls, inputs, outch, names, refused = None, {}, '', 0, {}, 0
        for line in open(path):
            d = json.loads(line)
            if d.get('type') == 'result': res = d
            if d.get('type') == 'assistant':
                for b in d['message']['content']:
                    if b.get('type') == 'tool_use':
                        names[b['id']] = b['name']
                        inputs += json.dumps(b['input'])
            if d.get('type') == 'user' and isinstance(d['message']['content'], list):
                for b in d['message']['content']:
                    if b.get('type') == 'tool_result':
                        c = b['content'] if isinstance(b['content'], str) else ' '.join(x.get('text', '') for x in b['content'] if isinstance(x, dict))
                        outch += len(c)
                        # deny_direct refuses a direct call; count it apart from the calls that ran
                        if 'from a program instead' in c: refused += 1
                        else: calls[names[b['tool_use_id']]] = calls.get(names[b['tool_use_id']], 0) + 1
        if not res: print(name, 'no result'); continue
        u = res['usage']
        inp = u['input_tokens'] + u['cache_read_input_tokens'] + u['cache_creation_input_tokens']
        ans = res.get('result', '')
        fulltext = bool(re.search(r'pmc_ids[^]]*' + PMC, inputs))
        if re.search(PAPER, ans, re.I):
            verdict = 'pass' if PASSES(ans) else 'FAIL'
        else:
            verdict = 'not cited'
        print(f"{name}: {inp} input, {u['output_tokens']} output, ${res.get('total_cost_usd', 0):.2f}, "
              f"{res['num_turns']} turns, {res['duration_ms'] // 1000}s, {outch} chars of tool output; "
              f"{TRAP}: {verdict}{' (full text fetched)' if fulltext else ''}; calls: {calls}; refused: {refused}")
print('streams:', T)
