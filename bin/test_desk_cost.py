"""The cheap role's light gate, and cost from CLI logs."""
import json
import unittest

import desk_runtime as rt

ENG = {'address': 'e1', 'role': 'worker', 'task': 'desk', 'cli': 'claude'}


def light(files=('src/a.ts',), note='read the diff', allowed=True, head='h1', dirty=False):
    return rt.light_gate_verdict(ENG, head, dirty, list(files) if files is not None else None, note, allowed)


class LightGate(unittest.TestCase):
    def test_passes_a_clean_mechanical_branch(self):
        v = light()
        self.assertEqual('pass', v['verdict'])
        self.assertEqual('read the diff', v['review']['note'])

    def test_a_role_without_light_review_is_refused(self):
        self.assertEqual('fail', light(allowed=False)['verdict'])

    def test_every_risky_area_is_refused(self):
        for path in ('src/auth/guard.ts', 'api/payments/refund.go', 'db/migrations/0012.sql', 'packages/contracts/schema.ts',
                     'app/session-store.ts', '.env.local', '.github/workflows/ci.yml', 'lib/Stripe.ts'):
            v = light(files=['src/ok.ts', path])
            self.assertEqual('fail', v['verdict'], path)
            self.assertIn(path, v['reasons'][0])

    def test_uncommitted_work_empty_branch_and_unknown_files_are_refused(self):
        self.assertEqual('fail', light(dirty=True)['verdict'])
        self.assertEqual('fail', light(files=[])['verdict'])
        self.assertEqual('fail', light(files=None)['verdict'])
        self.assertEqual('fail', light(head=None)['verdict'])

    def test_it_needs_a_note_of_what_was_checked(self):
        self.assertEqual('fail', light(note='   ')['verdict'])


def line(mid, model='claude-sonnet-5-5', **usage):
    return json.dumps({'type': 'assistant', 'message': {'id': mid, 'model': model, 'usage': usage}})


class Cost(unittest.TestCase):
    def test_call_cost_prices_each_token_kind(self):
        usage = {'input_tokens': 1000000, 'output_tokens': 1000000, 'cache_read_input_tokens': 1000000,
                 'cache_creation_input_tokens': 2000000,
                 'cache_creation': {'ephemeral_1h_input_tokens': 1000000, 'ephemeral_5m_input_tokens': 1000000}}
        self.assertAlmostEqual(2 + 10 + 0.2 + 4 + 2.5, rt.call_cost('claude-sonnet-5-5', usage))

    def test_a_cache_write_without_a_split_counts_as_5m(self):
        self.assertAlmostEqual(2.5, rt.call_cost('claude-sonnet-5-5', {'cache_creation_input_tokens': 1000000}))

    def test_haiku_costs_more_past_100k_prompt_tokens(self):
        small = rt.call_cost('claude-haiku-5-5', {'input_tokens': 100000})
        big = rt.call_cost('claude-haiku-5-5', {'input_tokens': 100001})
        self.assertAlmostEqual(small * 5, big, places=4)

    def test_an_unknown_model_has_no_price(self):
        self.assertIsNone(rt.call_cost('gpt-6.1-sol', {'input_tokens': 5}))

    def test_a_message_split_over_lines_counts_once_with_its_last_usage(self):
        u = rt.transcript_usage([line('m1', input_tokens=10, output_tokens=1), line('m1', input_tokens=10, output_tokens=50),
                                 line('m2', input_tokens=5, output_tokens=5), 'not json "usage"',
                                 json.dumps({'type': 'user', 'message': {'usage': {'input_tokens': 999}}})])
        self.assertEqual((2, 15, 55), (u['calls'], u['input'], u['output']))
        self.assertTrue(u['priced'])

    def test_synthetic_lines_are_skipped_and_unknown_models_flagged(self):
        self.assertEqual(0, rt.transcript_usage([line('m', model='<synthetic>', input_tokens=1)])['calls'])
        self.assertFalse(rt.transcript_usage([line('m', model='new-model', input_tokens=1)])['priced'])

    def test_codex_uses_the_last_running_total_and_splits_out_cached_input(self):
        def tc(i, c, o):
            return json.dumps({'payload': {'type': 'token_count', 'info': {'total_token_usage': {
                'input_tokens': i, 'cached_input_tokens': c, 'output_tokens': o}}}})
        u = rt.codex_usage([tc(10, 5, 1), json.dumps({'payload': {'type': 'token_count', 'info': None}}), tc(100, 80, 7)])
        self.assertEqual((2, 20, 80, 7), (u['calls'], u['input'], u['cache_read'], u['output']))
        self.assertIsNone(u['cost'])
        self.assertIsNone(rt.codex_usage(['{}']))


if __name__ == '__main__':
    unittest.main()
