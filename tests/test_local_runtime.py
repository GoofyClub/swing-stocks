import datetime as dt
import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runtime',Path(__file__).resolve().parents[1]/'packaging/runtime.py')
runtime=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
class ScheduleTests(unittest.TestCase):
    def jobs(self,stamp,completed=None,broad=False):
        return runtime.due_jobs(dt.datetime.fromisoformat(stamp),completed or {},broad)
    def test_dst_and_entry_deadline(self):
        summer=self.jobs('2026-10-15T19:39:00+00:00',broad=True)
        winter=self.jobs('2026-11-16T20:39:00+00:00',broad=True)
        self.assertTrue(any(k.endswith(':entry') for k,_ in summer))
        self.assertTrue(any(k.endswith(':entry') for k,_ in winter))
        self.assertFalse(any(k.endswith(':entry') for k,_ in self.jobs('2026-10-15T19:51:00+00:00',broad=True)))
        self.assertFalse(any(k.endswith(':entry') for k,_ in self.jobs('2026-10-15T19:39:00+00:00')))
    def test_completed_job_not_repeated_and_weekends_skipped(self):
        done={'2026-10-15:entry':{'done':True}}
        self.assertFalse(any(k.endswith(':entry') for k,_ in self.jobs('2026-10-15T19:44:00+00:00',done)))
        self.assertTrue(all('safety:' in k for k,_ in self.jobs('2026-10-17T19:44:00+00:00')))
    def test_safety_repeats_each_market_minute_and_works_outside_entry_window(self):
        first=self.jobs('2026-10-15T13:31:00+00:00')
        key=next(k for k,_ in first if k.startswith('safety:'))
        self.assertFalse(any(k==key for k,_ in self.jobs('2026-10-15T13:31:30+00:00',{key:{'done':True}})))
        self.assertTrue(any(k.startswith('safety:') and k!=key for k,_ in self.jobs('2026-10-15T13:32:00+00:00',{key:{'done':True}})))
class ConfigureTests(unittest.TestCase):
    def test_new_install_is_paused_and_rerun_preserves_state(self):
        spec=importlib.util.spec_from_file_location('configure',Path(__file__).resolve().parents[1]/'packaging/configure.py')
        configure=importlib.util.module_from_spec(spec);spec.loader.exec_module(configure)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);data=root/'data'
            answers=['fixture-key','fixture-secret','123456:fixture','123','tester','fixture-password','fixture-password']
            with patch.object(configure.getpass,'getpass',side_effect=answers):configure.main(root,data)
            env=(root/'swing-config/swing.env').read_text()
            self.assertIn("DRY_RUN='true'",env)
            self.assertNotIn('fixture-password',env)
            self.assertEqual(json.loads((data/'control.json').read_text()),{'paused':True})
            (data/'control.json').write_text('{"paused":false}')
            with patch.object(configure.getpass,'getpass',side_effect=AssertionError('must not prompt')):configure.main(root,data)
            self.assertEqual((root/'swing-config/swing.env').read_text(),env)
            self.assertFalse(json.loads((data/'control.json').read_text())['paused'])
if __name__=='__main__':unittest.main()
