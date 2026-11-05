import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(__file__))
from desk_runtime import Store, RuntimeError, attention, dispatch, foreground_agent, queue_item, recover_interrupted_claims, reorder, session_view, upsert_session

def live(name="claude", status="idle"):
    return {"state":"live", "foreground":{"name":name}, "status":{"state":status}, "labels":{}}

class RuntimeTest(unittest.TestCase):
    def setUp(self): self.tmp = tempfile.TemporaryDirectory(); self.store = Store(self.tmp.name, clock=lambda: 7); self.data = self.store.load()
    def tearDown(self): self.tmp.cleanup()
    def test_store_is_private_and_atomic_round_trip(self):
        self.store.save(self.data); self.assertEqual(0o600, os.stat(self.store.path).st_mode & 0o777); self.assertEqual(self.data, self.store.load())
    def ended(self, rec, reason="killed"):
        return session_view(rec, {"t1":{"state":"finished", "reason":reason}})
    def test_killed_after_its_done_report_is_finished_not_lost(self):
        rec = upsert_session(self.data, {"address":"t1","role":"reviewer","task":"a","cli":"codex","evidence_at":100})
        self.assertEqual("finished", self.ended(rec)["state"])
        self.assertEqual([], attention(self.data, {"t1":{"state":"finished", "reason":"killed"}}, [])[:1])
    def test_killed_without_a_done_report_stays_resumable(self):
        view = self.ended({"address":"t1","cli":"claude","conversation":"abc"})
        self.assertEqual("disconnected", view["state"]); self.assertTrue(view["can_resume"])
    def test_a_crash_after_done_is_still_a_loss(self):
        self.assertEqual("disconnected", self.ended({"address":"t1","cli":"claude","conversation":"abc","evidence_at":100}, "exited")["state"])
    def test_killed_during_new_work_after_done_is_still_a_loss(self):
        self.assertEqual("disconnected", self.ended({"address":"t1","cli":"claude","conversation":"abc","evidence_at":100,"prompt_at":200})["state"])
        self.assertEqual("finished", self.ended({"address":"t1","cli":"claude","conversation":"abc","evidence_at":300,"prompt_at":200})["state"])
    def test_shell_is_disconnected_even_when_labeled_live(self):
        rec = upsert_session(self.data, {"address":"t1","role":"cto","task":"a","cli":"claude","conversation":"abc"})
        view = session_view(rec, {"t1":live("zsh")}); self.assertEqual("disconnected", view["state"]); self.assertTrue(view["can_resume"])
    def test_herdr_version_name_uses_argv_and_status_identity(self):
        terminal = live("2.1.318"); terminal["foreground"]["argv"] = ["claude", "--resume", "x"]; terminal["status"] = {"app":"claude-code", "state":"done"}
        self.assertEqual("active", session_view({"address":"t1","cli":"claude","conversation":"x"},{"t1":terminal})["state"])
    def test_unknown_adapter_is_actionable(self):
        view = session_view({"address":"t1","cli":"muse","conversation":"x"}, {}); self.assertFalse(view["can_resume"]); self.assertIn("resume", view["recovery_reason"])
    def test_claude_can_fork_only_when_active(self):
        rec = {"address":"t1","cli":"claude","conversation":"x"}
        self.assertTrue(session_view(rec,{"t1":live()})["can_fork"])
        self.assertFalse(session_view(rec,{})["can_fork"])
    def test_queue_edits_order_and_cancel_ready_data(self):
        a=queue_item(self.data,"d","first",[{"address":"t1","role":"cto"}],clock=lambda:1); b=queue_item(self.data,"d","second",[{"address":"t1","role":"cto"}],clock=lambda:2)
        b["position"],a["position"]=0,1; reorder(self.data); self.assertEqual(["second","first"],[x["text"] for x in sorted(self.data["queue"],key=lambda x:x["position"])])
    def test_dispatch_never_sends_to_shell_or_retries_uncertain(self):
        item=queue_item(self.data,"d","hello",[{"address":"t1","role":"cto"}]); self.assertEqual("failed",dispatch(self.data,{"t1":live("zsh")},lambda *_:None)["state"])
        item["state"]="pending"; result=dispatch(self.data,{"t1":live()},lambda *_:"transport ended after write"); self.assertEqual("uncertain",result["state"]); self.assertIsNone(dispatch(self.data,{"t1":live()},lambda *_:None))
    def test_busy_target_stays_pending(self):
        item=queue_item(self.data,"d","hello",[{"address":"t1","role":"cto"}]); self.assertIsNone(dispatch(self.data,{"t1":live(status="working")},lambda *_:None)); self.assertEqual("pending",item["state"])
    def test_attention_uses_stable_ids_and_dismissal(self):
        rec=upsert_session(self.data,{"address":"t1","role":"cto","task":"d","cli":"claude","conversation":"x","at":1}); items=attention(self.data,{},[]); self.assertEqual("session:"+rec["id"],items[0]["id"]); self.data["dismissed"].append(items[0]["id"]); self.assertFalse(attention(self.data,{},[]))
    def test_malformed_queue_is_rejected(self):
        with self.assertRaises(RuntimeError): queue_item(self.data,"d","",[],clock=lambda:1)
    def test_interrupted_claim_is_never_retried(self):
        item = queue_item(self.data,"d","hello",[{"address":"t1","role":"cto"}]); item["state"] = "dispatching"
        recover_interrupted_claims(self.data); self.assertEqual("uncertain", item["state"]); self.assertIn("interrupted", item["error"])

if __name__ == "__main__": unittest.main()
