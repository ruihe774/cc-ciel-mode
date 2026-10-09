# Summarizes the runs of e2e/pubmed.sh: python3 e2e/pubmed-report.py <dir> <runs per mode>
import json, os, re, sys

T, runs = sys.argv[1], int(sys.argv[2])
PAPER = r'Manouchehri|33653334|12905-021-01233|PMC7927396|7927396'
for mode in ('off', 'on', 'deny'):
    for i in range(1, runs + 1):
        name = f'{mode}{i}'
        path = os.path.join(T, name + '.jsonl')
        if not os.path.exists(path): continue
        res, calls, inputs, outch = None, {}, '', 0
        for line in open(path):
            d = json.loads(line)
            if d.get('type') == 'result': res = d
            if d.get('type') == 'assistant':
                for b in d['message']['content']:
                    if b.get('type') == 'tool_use':
                        calls[b['name']] = calls.get(b['name'], 0) + 1
                        inputs += json.dumps(b['input'])
            if d.get('type') == 'user' and isinstance(d['message']['content'], list):
                for b in d['message']['content']:
                    if b.get('type') == 'tool_result':
                        c = b['content'] if isinstance(b['content'], str) else ' '.join(x.get('text', '') for x in b['content'] if isinstance(x, dict))
                        outch += len(c)
        if not res: print(name, 'no result'); continue
        u = res['usage']
        inp = u['input_tokens'] + u['cache_read_input_tokens'] + u['cache_creation_input_tokens']
        ans = res.get('result', '')
        fulltext = bool(re.search(r'7927396', inputs))
        if re.search(PAPER, ans):
            ok = re.search(r'1\.02', ans) and re.search(r'trim.{0,5}fill', ans, re.I)
            verdict = 'pass' if ok else 'FAIL'
        else:
            verdict = 'not cited'
        print(f"{name}: {inp} input, {u['output_tokens']} output, ${res.get('total_cost_usd', 0):.2f}, "
              f"{res['num_turns']} turns, {res['duration_ms'] // 1000}s, {outch} chars of tool output; "
              f"Manouchehri: {verdict}{' (full text fetched)' if fulltext else ''}; calls: {calls}")
print('streams:', T)
