#!/usr/bin/env python3
"""Linux/Windows release APK builder; requires existing SDK, JDK and signing key.
Run npm run mobile:build in _tools/app first. No dependencies or keys are created.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-root', default=os.environ.get('ANDROID_SDK_ROOT'))
    parser.add_argument('--java-home', default=os.environ.get('JAVA_HOME'))
    args = parser.parse_args()
    if not args.sdk_root or not args.java_home:
        parser.error('Set SDK/JDK paths through arguments or ANDROID_SDK_ROOT/JAVA_HOME.')
    root = Path(__file__).resolve().parent
    build, assets = root / 'build', root / 'assets'
    build.mkdir(exist_ok=True)
    sdk, java = Path(args.sdk_root), Path(args.java_home)
    bt, android = sdk / 'build-tools/35.0.0', sdk / 'platforms/android-35/android.jar'
    key = build / 'debug.keystore'
    if not key.is_file() or not (assets / 'index.html').is_file():
        parser.error('Existing installation keystore and built mobile assets are required.')
    manifest = ET.parse(root / 'AndroidManifest.xml').getroot()
    attr = '{http://schemas.android.com/apk/res/android}'
    if manifest.find('application').get(attr + 'debuggable') != 'false':
        parser.error('Manifest must explicitly disable debugging.')
    output = build / ('lakomics-mobile-' + manifest.get(attr + 'versionName') + '-release.apk')
    env = os.environ.copy()
    env['JAVA_HOME'] = str(java)
    env['PATH'] = str(java / 'bin') + os.pathsep + env.get('PATH', '')
    env['LAKOMICS_INSTALL_KEY_PASSWORD'] = 'android'

    def exe(folder, name):
        suffix = ('.bat' if name in ('d8', 'apksigner') else '.exe') if os.name == 'nt' else ''
        return folder / (name + suffix)

    def run(*argv):
        subprocess.run([str(v) for v in argv], check=True, env=env)

    with tempfile.TemporaryDirectory(prefix='release-', dir=build) as tmp:
        work = Path(tmp)
        classes, dex, tests = (work / n for n in ('classes', 'dex', 'tests'))
        for folder in (classes, dex, tests):
            folder.mkdir()
        javac, java_cmd = exe(java / 'bin', 'javac'), exe(java / 'bin', 'java')
        run(javac, '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android,
            '-d', classes, *sorted((root / 'src').rglob('*.java')))
        checks = ['NetworkPolicy', 'DocumentTreePolicy', 'ThumbnailCache', 'PickerSnapshot',
                  'MediaTransfer', 'TemporaryImagePolicy', 'NotesCrypto']
        sources = [p for name in checks for p in (root / f'src/com/lakomics/mobile/{name}.java', root / f'tests/{name}Test.java')]
        run(javac, '-encoding', 'UTF-8', '-d', tests, *sources)
        for name in checks:
            run(java_cmd, '-cp', tests, f'com.lakomics.mobile.{name}Test')
        jar = work / 'classes.jar'
        run(exe(java / 'bin', 'jar'), 'cf', jar, '-C', classes, '.')
        run(exe(bt, 'd8'), '--release', '--min-api', '26', '--lib', android, '--output', dex, jar)
        resources, unsigned, aligned = (work / n for n in ('resources.zip', 'unsigned.apk', 'aligned.apk'))
        run(exe(bt, 'aapt2'), 'compile', '--dir', root / 'res', '-o', resources)
        run(exe(bt, 'aapt2'), 'link', '-o', unsigned, '--manifest', root / 'AndroidManifest.xml', '-I', android, resources)
        with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(dex.glob('*.dex')):
                archive.write(file, file.name)
            for file in sorted(assets.rglob('*')):
                if file.is_file():
                    archive.write(file, 'assets/' + file.relative_to(assets).as_posix())
        with zipfile.ZipFile(unsigned) as archive:
            for file in assets.rglob('*'):
                if file.is_file() and archive.read('assets/' + file.relative_to(assets).as_posix()) != file.read_bytes():
                    raise RuntimeError('APK asset mismatch')
            if any('\\' in name for name in archive.namelist()):
                raise RuntimeError('Nonportable ZIP entry')
        run(exe(bt, 'zipalign'), '-f', '4', unsigned, aligned)
        run(exe(bt, 'apksigner'), 'sign', '--ks', key, '--ks-key-alias', 'androiddebugkey',
            '--ks-pass', 'env:LAKOMICS_INSTALL_KEY_PASSWORD', '--key-pass', 'env:LAKOMICS_INSTALL_KEY_PASSWORD',
            '--out', output, aligned)
        run(exe(bt, 'apksigner'), 'verify', '--verbose', '--print-certs', output)
    print(f'{output}\nSHA256 {hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main()
