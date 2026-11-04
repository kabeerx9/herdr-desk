"""Exercise the actual CLI orchestration without contacting a live user terminal."""
import contextlib
import copy
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
loader = importlib.machinery.SourceFileLoader('desk_team_test', os.path.join(os.path.dirname(__file__), 'team'))
spec = importlib.util.spec_from_loader(loader.name, loader)
team = importlib.util.module_from_spec(spec)
loader.exec_module(team)


def terminal(name='claude', state='idle', task='desk', role='cto'):
    return {'address':'t1', 'state':'live', 'foreground':{'name':name, 'argv':[name]},
            'status':{'state':state, 'app':name}, 'cwd':'/tmp',
            'labels':{'task':task,'role':role,'herdr.space':'space','herdr.tab':'tab'}}


class TeamWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.role = {'id':'cto','name':'CTO','cli':'claude','promptText':'Keep the existing contract.', 'tools':['Read']}
        self.info = terminal()
        self.patches = [patch.object(team,'CHAT',self.tmp.name), patch.object(team,'ME',None),
                        patch.object(team,'load_roles',lambda:[copy.deepcopy(self.role)]),
                        patch.object(team,'runtime_terminals',lambda:{'t1':copy.deepcopy(self.info)}),
                        patch.object(team,'terminal',lambda address:copy.deepcopy(self.info)),
                        patch.object(team,'unique_name',lambda name:name[:30]),
                        patch.object(team,'rename_tab',lambda *args:True)]
        for p in self.patches: p.start()
        self.addCleanup(lambda:[p.stop() for p in reversed(self.patches)])
        self.addCleanup(self.tmp.cleanup)
        self.record = team.runtime_record('t1','cto','desk','/tmp','claude','saved-conversation')

    def call(self, fn, **kwargs):
        output=io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()): fn(types.SimpleNamespace(**kwargs))
        return json.loads(output.getvalue()) if output.getvalue().strip() else None

    def test_recovery_restores_conversation_without_replaying_task(self):
        self.info=terminal('zsh')
        with patch.object(team,'sh',return_value=subprocess.CompletedProcess([],0,'{}','')) as run:
            result=self.call(team.runtime_recover,session=self.record['id'])
        self.assertEqual('t1',result['address'])
        command=run.call_args.args[0][-1]
        self.assertIn('--resume saved-conversation',command)
        self.assertNotIn('Answer this question',command)

    def test_recovery_does_not_inject_a_second_launch(self):
        self.info=terminal('zsh')
        with patch.object(team,'sh',return_value=subprocess.CompletedProcess([],0,'{}','')) as run:
            self.call(team.runtime_recover,session=self.record['id'])
            with self.assertRaises((SystemExit,team.DeskRuntimeError)):
                self.call(team.runtime_recover,session=self.record['id'])
        self.assertEqual(1,run.call_count)

    def test_recovery_rejects_a_live_agent(self):
        with patch.object(team,'sh') as run, self.assertRaises((SystemExit,team.DeskRuntimeError)):
            self.call(team.runtime_recover,session=self.record['id'])
        run.assert_not_called()

    def test_custom_adapter_resume_uses_configured_arguments(self):
        self.role={'id':'cto','name':'Lead','cli':'muse-code','argv':['muse-code'], 'promptText':'',
                   'adapter':{'resume_args':['resume','{session_id}']}}
        team.runtime_store().mutate(lambda d:d['sessions'][0].update(cli='muse-code',role_config=self.role,
            capabilities={'resume':True,'fork':False}))
        self.info=terminal('zsh')
        with patch.object(team,'sh',return_value=subprocess.CompletedProcess([],0,'{}','')) as run:
            self.call(team.runtime_recover,session=self.record['id'])
        self.assertIn('muse-code resume saved-conversation',run.call_args.args[0][-1])

    def test_queue_blocks_a_second_message_until_first_reply(self):
        store=team.runtime_store()
        for text in ['first','second']:
            store.mutate(lambda d:team.runtime_queue_item(d,'desk',text,[{'address':'t1','role':'cto'}]))
        sent=[]
        def expect(*args): self.info['labels']['awaiting']='chat:1'; return True
        with patch.object(team,'send_text',side_effect=lambda a,t:sent.append(t)), patch.object(team,'expect_reply',side_effect=expect), patch.object(team,'chat_append',return_value={}):
            self.call(team.runtime_queue_dispatch)
            self.call(team.runtime_queue_dispatch)
            self.assertEqual(1,len(sent))
            self.info['labels'].pop('awaiting')
            self.call(team.runtime_queue_dispatch)
        self.assertEqual(2,len(sent))

    def test_queue_preserves_failure_without_automatic_retry(self):
        store=team.runtime_store()
        store.mutate(lambda d:team.runtime_queue_item(d,'desk','hello',[{'address':'t1','role':'cto'}]))
        with patch.object(team,'send_text',return_value='transport disconnected after write') as send, patch.object(team,'expect_reply',return_value=True):
            result=self.call(team.runtime_queue_dispatch)
            self.call(team.runtime_queue_dispatch)
        self.assertEqual('uncertain',result['state']); self.assertEqual(1,send.call_count)

    def test_queue_edit_cancel_and_reorder_actual_commands(self):
        store=team.runtime_store()
        first=store.mutate(lambda d:dict(team.runtime_queue_item(d,'desk','a',[{'address':'t1','role':'cto'}])))
        second=store.mutate(lambda d:dict(team.runtime_queue_item(d,'desk','b',[{'address':'t1','role':'cto'}])))
        self.call(team.runtime_queue_edit,id=first['id'],text='edited')
        self.call(team.runtime_queue_move,id=second['id'],direction='up')
        self.assertEqual(second['id'],min(store.load()['queue'],key=lambda q:q['position'])['id'])
        self.call(team.runtime_queue_cancel,id=second['id'])
        self.assertEqual('cancelled',store.load()['queue'][1]['state'])
        self.assertEqual('edited',store.load()['queue'][0]['text'])

    def test_dispatch_lock_serializes_external_delivery(self):
        store=team.runtime_store(); entered=[]
        def run(n):
            with store.dispatch_lock():
                entered.append(('start',n)); time.sleep(.015); entered.append(('end',n))
        threads=[threading.Thread(target=run,args=(i,)) for i in range(3)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(['start','end']*3,[kind for kind,_ in entered])

    def test_concurrent_registry_writes_do_not_drop_sessions(self):
        def add(i): team.runtime_record('test'+str(i),'cto','desk','/tmp','claude',str(i))
        threads=[threading.Thread(target=add,args=(i,)) for i in range(12)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(13,len(team.runtime_store().load()['sessions']))

    def test_finished_shell_and_pager_never_receive_a_chat(self):
        for name in ['zsh','less','python3']:
            self.info=terminal(name)
            with patch.object(team,'sh') as run:
                error=team.send_text('t1','hello')
            self.assertTrue(error);run.assert_not_called()

    def test_busy_project_does_not_block_another_projects_queue(self):
        other=terminal(task='other'); other['address']='t2'
        self.info=terminal(state='working')
        store=team.runtime_store()
        store.mutate(lambda d:team.runtime_queue_item(d,'desk','busy',[{'address':'t1','role':'cto'}]))
        store.mutate(lambda d:team.runtime_queue_item(d,'other','ready',[{'address':'t2','role':'cto'}]))
        with patch.object(team,'runtime_terminals',return_value={'t1':self.info,'t2':other}), patch.object(team,'send_text',return_value=None) as send, patch.object(team,'expect_reply'), patch.object(team,'chat_append',return_value={}):
            self.call(team.runtime_queue_dispatch)
        send.assert_called_once_with('t2','[desk chat] Kabeer: ready')

    def test_recovery_can_replace_a_lost_terminal_without_replaying_input(self):
        with patch.object(team,'runtime_terminals',return_value={}), patch.object(team,'terminal',return_value={}), patch.object(team,'sh',return_value=subprocess.CompletedProcess([],0,'{"address":"t2"}','')) as run:
            result=self.call(team.runtime_recover,session=self.record['id'])
        self.assertEqual('t2',result['address'])
        self.assertEqual('t2',team.runtime_store().load()['sessions'][0]['address'])
        self.assertIn('--resume',run.call_args.args[0])

    def test_recovery_never_replaces_a_pager_occupying_the_old_terminal(self):
        self.info=terminal('less')
        with patch.object(team,'sh') as run, self.assertRaises(SystemExit):
            self.call(team.runtime_recover,session=self.record['id'])
        run.assert_not_called()

    def test_resolved_and_expired_permissions_leave_attention(self):
        now=int(time.time()*1000)
        chats=[{'task':'desk','kind':'permission','id':'p','at':now,'address':'t1'},
               {'task':'desk','kind':'permission-done','re':'p','at':now+1},
               {'task':'desk','kind':'permission','id':'old','at':now-600000,'address':'t1'}]
        self.info=terminal(state='blocked')
        from desk_runtime import attention
        self.assertEqual([],attention(team.runtime_store().load(),{'t1':self.info},chats))

    def test_completed_report_replaces_previous_blocked_report(self):
        from desk_runtime import attention
        chats=[{'task':'desk','from':'cto','address':'t1','kind':'blocked','at':1,'text':'failed check'},
               {'task':'desk','from':'cto','address':'t1','kind':'done','at':2,'text':'checks passed'}]
        items=attention(team.runtime_store().load(),{'t1':self.info},chats)
        self.assertEqual(['done'],[x['kind'] for x in items])

    def test_queue_reservation_failure_does_not_send(self):
        store=team.runtime_store()
        store.mutate(lambda d:team.runtime_queue_item(d,'desk','hello',[{'address':'t1','role':'cto'}]))
        with patch.object(team,'expect_reply',return_value=False), patch.object(team,'send_text') as send:
            result=self.call(team.runtime_queue_dispatch)
        send.assert_not_called()
        self.assertEqual('not_sent',result['deliveries']['t1']['state'])

    def test_side_launch_reserves_and_logs_its_first_reply(self):
        args=dict(role='cto',repo=self.tmp.name,brief=None,task='Read-only question',slug='side-test',
                  parent=None,no_parent=True,space=None,requested=True,by='desk',share=True,tab=None,
                  fresh_of=None,note=None,display_task='What does this mean?')
        with patch.object(team,'need_core'), patch.object(team,'repo_of',return_value=None), patch.object(team,'sh',return_value=subprocess.CompletedProcess([],0,'{"address":"t2"}','')) as launch:
            self.call(team.start,**args)
        command=launch.call_args_list[0].args[0]
        self.assertTrue(any(str(arg).startswith('awaiting=chat:') for arg in command))
        self.assertIn('--session-id',command)
        messages=team.chat_read('side-test')
        question=next(m for m in messages if m.get('kind')=='say')
        self.assertEqual('What does this mean?',question['text'])
        self.assertEqual(['t2'],question['delivered_to'])

    def test_generic_session_hook_records_identity_before_first_reply(self):
        with patch.object(team,'ME','t1'),patch.object(team.sys,'stdin',io.StringIO('{"session_id":"new-identity"}')):
            self.call(team.hook,cli='session')
        self.assertEqual('new-identity',team.runtime_store().load()['sessions'][0]['conversation'])

    def test_fork_metadata_failure_never_removes_a_launched_worktree(self):
        repo=Path(self.tmp.name)/'repo';repo.mkdir()
        for args in [('init',),('config','user.email','test@example.com'),('config','user.name','Test')]:
            subprocess.run(['git',*args],cwd=str(repo),check=True,capture_output=True)
        (repo/'file.txt').write_text('seed\n')
        subprocess.run(['git','add','.'],cwd=str(repo),check=True,capture_output=True)
        subprocess.run(['git','commit','-m','seed'],cwd=str(repo),check=True,capture_output=True)
        real_sh=team.sh
        def run(args,cwd=None,check=False):
            if args[:2]==['hc','run']: return subprocess.CompletedProcess(args,0,'{"address":"t2"}','')
            return real_sh(args,cwd=cwd,check=check)
        record={**self.record,'cwd':str(repo),'conversation':'saved-conversation'}
        with patch.object(team,'WORKTREES',str(Path(self.tmp.name)/'trees')),patch.object(team,'sh',side_effect=run),patch.object(team,'chat_append',side_effect=OSError('metadata write failed')):
            with self.assertRaises(OSError):team.runtime_fork(types.SimpleNamespace(text=None),record,{'can_fork':True})
        trees=list((Path(self.tmp.name)/'trees'/'repo').glob('*'))
        self.assertEqual(1,len(trees));self.assertTrue((trees[0]/'file.txt').exists())

if __name__=='__main__':unittest.main()
