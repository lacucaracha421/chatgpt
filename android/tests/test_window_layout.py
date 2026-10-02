"""Offline window/WebView contracts; run with unittest discovery in android/tests."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
JAVA = ROOT / 'android/src/com/lakomics/mobile/MainActivity.java'
ATTR = '{http://schemas.android.com/apk/res/android}'


class WindowLayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = JAVA.read_text()

    def test_layout_is_stable_before_the_webview_is_created(self):
        source = self.source
        self.assertLess(source.index('configureWindow();'), source.index('web=new WebView'))
        self.assertIn('getWindow().setDecorFitsSystemWindows(false)', source)
        self.assertRegex(source, r'if\(Build.VERSION.SDK_INT>=30\).*setDecorFitsSystemWindows\(false\)')
        for flag in ('LAYOUT_STABLE', 'LAYOUT_FULLSCREEN'):
            self.assertIn('View.SYSTEM_UI_FLAG_' + flag, source)
        self.assertNotIn('View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION', source)

    def test_transient_status_bar_does_not_change_css_safe_area(self):
        source = self.source
        self.assertIn('.setInsets(WindowInsets.Type.statusBars(),android.graphics.Insets.NONE)', source)
        self.assertIn('.setInsetsIgnoringVisibility(WindowInsets.Type.statusBars(),android.graphics.Insets.NONE)', source)
        self.assertIn('replaceSystemWindowInsets(insets.getSystemWindowInsetLeft(),0,insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom())', source)
        self.assertNotIn('v.setPadding(i.left,i.top,i.right,i.bottom)', source)

    def test_navigation_and_cutout_insets_are_not_consumed(self):
        source = self.source
        self.assertNotIn('WindowInsets.CONSUMED', source)
        self.assertNotRegex(source, r'setInsets(?:IgnoringVisibility)?\(WindowInsets.Type.(?:systemBars|navigationBars|displayCutout)\(')
        css = (ROOT / '_tools/app/mobile-client/mobile.css').read_text()
        self.assertRegex(css, r'\.bottom-nav\s*\{[^}]*env\(safe-area-inset-bottom\)')
        self.assertIn('viewport-fit=cover', (ROOT / '_tools/app/mobile-client/index.html').read_text())

    def test_keyboard_resize_still_removes_only_the_handled_ime(self):
        self.assertIn('v.setPadding(0,0,0,insets.getInsets(WindowInsets.Type.ime()).bottom)', self.source)
        self.assertIn('.setInsets(WindowInsets.Type.ime(),android.graphics.Insets.NONE)', self.source)

    def test_hide_is_guarded_by_current_visibility(self):
        self.assertIn('insets!=null&&!insets.isVisible(WindowInsets.Type.statusBars())', self.source)
        self.assertIn('(getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_FULLSCREEN)==0', self.source)

    def test_activity_background_matches_the_page(self):
        tokens = (ROOT / '_tools/app/src/styles/tokens.css').read_text()
        color = re.search(r'--color-bg:\s*(#[0-9a-f]{6})', tokens).group(1)
        manifest = ET.parse(ROOT / 'android/AndroidManifest.xml').getroot()
        activity = next(a for a in manifest.find('application').findall('activity') if a.get(ATTR + 'name') == '.MainActivity')
        self.assertEqual(activity.get(ATTR + 'theme'), '@style/LakomicsTheme')
        theme = ET.parse(ROOT / 'android/res/values/styles.xml').getroot().find('style')
        self.assertEqual(theme.get('parent'), '@android:style/Theme.Material.NoActionBar')
        background = next(i for i in theme.findall('item') if i.get('name') == 'android:windowBackground')
        self.assertEqual(background.text, color)
        self.assertIn('Color.rgb(22,23,24)', self.source)
        self.assertIn(f'content="{color}"', (ROOT / '_tools/app/mobile-client/index.html').read_text())


if __name__ == '__main__':
    unittest.main()
