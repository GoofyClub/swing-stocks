import datetime as dt
import importlib.util
from pathlib import Path
import unittest
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
        self.assertEqual(self.jobs('2026-10-17T19:44:00+00:00'),[])
if __name__=='__main__':unittest.main()
