"""Offline lifecycle/privacy contracts; actual WebView frame timing needs a device."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
ACTIVITY = (ROOT / 'android/src/com/lakomics/mobile/MainActivity.java').read_text()
COVER = (ROOT / 'android/src/com/lakomics/mobile/WebViewResumeCover.java').read_text()


class ResumeCoverTest(unittest.TestCase):
    def test_capture_precedes_pause_and_timer_suspension(self):
        pause = ACTIVITY.split('protected void onPause(){', 1)[1].split('\n', 1)[0]
        self.assertLess(pause.index('resumeCover.pause(web)'), pause.index('emit("lakomics-pause"'))
        self.assertLess(pause.index('resumeCover.pause(web)'), pause.index('web.onPause()'))
        self.assertIn('Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)', COVER)
        self.assertIn('web.draw(new Canvas(candidate))', COVER)
        for persistence in ('FileOutputStream', '.compress(', 'saveWebArchive', 'capturePicture'):
            self.assertNotIn(persistence, COVER)

    def test_sensitive_screens_fail_closed(self):
        self.assertIn('!noteSnapshotSensitive', ACTIVITY)
        self.assertIn('WindowManager.LayoutParams.FLAG_SECURE)==0', ACTIVITY)
        self.assertIn('noteSnapshotSensitive=value;', ACTIVITY)
        self.assertIn('if(value)runOnUiThread', ACTIVITY)
        self.assertIn('if (!allowed.getAsBoolean()) { candidate.recycle(); return; }', COVER)
        notes = (ROOT / '_tools/app/mobile-client/Notes.tsx').read_text()
        self.assertIn('creatingSecret||!!note&&isSecret(note)||revealed', notes)
        self.assertIn('setResumeSnapshotSensitive?.(snapshotSensitive)', notes)

    def test_remove_after_ready_draw_with_bounded_timeout_and_no_fade(self):
        self.assertIn('web.postVisualStateCallback', COVER)
        self.assertIn('addOnDrawListener(nextDraw)', COVER)
        self.assertIn('web.postOnAnimation', COVER)
        self.assertIn('handler.postDelayed(timeout, 600)', COVER)
        self.assertIn('request != epoch', COVER)
        self.assertIn('handler.removeCallbacks(timeout)', COVER)
        self.assertIn('removeOnDrawListener(nextDraw)', COVER)
        self.assertNotIn('.animate(', COVER)
        self.assertNotIn('setRendererPriorityPolicy', ACTIVITY)

    def test_renderer_is_destroyed_and_replaced_instead_of_finishing_activity(self):
        gone = ACTIVITY.split('boolean onRenderProcessGone(', 1)[1].split('return true;', 1)[0]
        self.assertIn('resumeCover.clear()', gone)
        self.assertLess(gone.index('frame.removeView(v)'), gone.index('v.destroy()'))
        self.assertIn('web=null', gone)
        self.assertIn('foreground)createWebView()', gone)
        self.assertNotIn('finish()', gone)
        self.assertIn('if(web==null&&!destroyed)createWebView()', ACTIVITY)
        self.assertIn('onDestroy(){destroyed=true;if(resumeCover!=null)resumeCover.clear()', ACTIVITY)


if __name__ == '__main__':
    unittest.main()
