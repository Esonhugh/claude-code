#!/usr/bin/env python3
"""Synthetic binding and owned-header contracts, not a native/UI oracle."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('canonical_driver', SOURCE.parent / '.claude/skills/release-validation/scripts/run-binary-gate.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class NativeCanonicalBindingTest(unittest.TestCase):
    def fixture(self):
        nonce = 'a' * 32
        clock = {'nonce': nonce, 'pid': 789, 'timebaseNumer': 125, 'timebaseDenom': 3, 'openedAt': '50'}
        context = {'nativeJournal': True, 'captureId': 'unit-capture', 'binarySha256': 'b' * 64,
                   'childPid': 789, 'clock': clock, 'initialSize': {'columns': 200, 'rows': 60}}
        pane = {'plugin': 'cc-plugin-diff', 'id': 'diff', 'activation': 1, 'lease': 2, 'drawing': 5,
                'visible': True, 'shown': True, 'hasTree': True, 'placement': 'dock', 'focused': False}
        state = {'revision': 6, 'pane': pane}
        rect = {'x': 71, 'y': 0, 'width': 39, 'height': 34}
        witness = {**pane, 'revision': 6, 'mount': 1, 'paintable': True, 'rect': rect,
                   'bodyRect': {**rect, 'y': 1, 'height': 30}, 'actualFocusWithin': False, 'controls': []}
        frame = {'columns': 110, 'viewport': {'width': 110, 'height': 34}, 'buffer': 'alternate',
                 'cursor': {'x': 0, 'y': 0, 'visible': False},
                 'cells': [[71+x, 1, char, 1, ''] for x, char in enumerate('ALPHA_RELEASE_BODY')]}
        entry = {'frameId': 1, 'terminalUiRevision': 6, 'terminalPanes': [witness],
                 'native': {'profile': 'ink-post-write-v1', 'captureId': 'unit-capture', 'spanId': 1,
                            'rendererId': 1, 'rootEpoch': 3, 'columns': 110, 'rows': 34},
                 'nativeSpan': {'method': 'native-mach-frame-span-v1', 'clock': clock, 'threadId': 1,
                   'observationKind': 'output-transaction', 'markers': [
                       {'kind': kind, 'sequence': sequence, 'entry': str(tick), 'return': str(tick+1)}
                       for kind, sequence, tick in [(10,20,200),(12,21,210),(13,23,230),(11,24,240)]],
                   'writes': [{'sequence': 22, 'entry': '220', 'return': '221', 'result': 3, 'errno': 0, 'outputBytes': 3}]},
                 'rawStart': 9, 'rawEnd': 12, 'writeSequences': [22], 'outputBase64': base64.b64encode(b'abc').decode(),
                 'frameBase64': base64.b64encode(json.dumps(frame).encode()).decode()}
        bracket = {'method': 'native-mach-ioctl-resize-v1', 'nonce': nonce, 'childPid': 789,
                   'entry': '150', 'return': '151', 'timebaseNumer': 125, 'timebaseDenom': 3,
                   'result': 0, 'errno': 0, 'beforeSizeHex': struct.pack('HHHH',60,200,0,0).hex(),
                   'afterSizeHex': struct.pack('HHHH',34,110,0,0).hex()}
        io = [{'ioId':1,'kind':'initial-geometry','captureId':'unit-capture','geometryId':0,'rawOffset':0,'columns':200,'rows':60,'childPid':789},
              {'ioId':2,'kind':'output','captureId':'unit-capture','geometryId':0,'rawOffset':9,'start':0,'end':9},
              {'ioId':3,'kind':'resize-ack','captureId':'unit-capture','geometryId':1,'rawOffset':9,'columns':110,'rows':34,'succeeded':True,'nativeClockCorrelationCovered':True,'nativeBracket':bracket},
              {'ioId':4,'kind':'input','captureId':'unit-capture','geometryId':1,'rawOffset':9,'hex':'2f646966660d','actualOsReadCovered':False},
              {'ioId':5,'kind':'output','captureId':'unit-capture','geometryId':1,'rawOffset':12,'start':9,'end':12}]
        return state, entry, io, context

    def observe(self, state, entry, io, context, entries=None):
        return driver.canonical_frame_snapshot([state], entries or [entry], 0, io, native_context=context)

    def test_native_output_span_and_same_root_logical_observation(self):
        state, entry, io, context = self.fixture()
        found = self.observe(state, entry, io, context)
        self.assertIsNotNone(found)
        self.assertIn('ALPHA_RELEASE_BODY', found['body'])
        self.assertEqual(found['nativeBinding']['observationKind'], 'output-transaction')
        self.assertEqual(found['nativeBinding']['outputSourceFrameId'], 1)
        self.assertNotIn('broker', entry)
        logical = copy.deepcopy(entry)
        logical['frameId'] = logical['native']['spanId'] = 2
        logical['rawStart'] = logical['rawEnd'] = 12
        logical['writeSequences'] = logical['nativeSpan']['writes'] = []
        logical['outputBase64'] = ''
        logical['nativeSpan']['observationKind'] = 'logical-observation'
        for marker in logical['nativeSpan']['markers']:
            marker['sequence'] += 5
            marker['entry'], marker['return'] = str(int(marker['entry'])+100), str(int(marker['return'])+100)
        found = self.observe(state, logical, io, context, [entry,logical])
        self.assertEqual(found['nativeBinding']['observationKind'], 'logical-observation')
        self.assertEqual(found['nativeBinding']['outputSourceFrameId'], 1)
        logical['native']['rootEpoch'] = 4
        self.assertIsNone(driver.canonical_native_frame_binding(logical, [entry,logical], io, context))

    def test_native_rejects_missing_identity_wrong_clock_marker_and_geometry(self):
        state, entry, io, context = self.fixture()
        self.assertIsNone(driver.canonical_frame_snapshot([state], [entry], 0, io))
        self.assertIsNone(driver.canonical_frame_snapshot([state], [entry], 0, None, native_context=context))
        cases=[('captureId','foreign'),('childPid',True),('binarySha256',None)]
        for key,value in cases:
            with self.subTest(context=key):
                changed=copy.deepcopy(context);changed[key]=value
                self.assertIsNone(self.observe(state,entry,io,changed))
        for field,value in [('pid',True),('nonce','c'*32),('timebaseNumer',1),('openedAt','051')]:
            with self.subTest(clock=field):
                changed=copy.deepcopy(entry);changed['nativeSpan']['clock'][field]=value
                self.assertIsNone(self.observe(state,changed,io,context))
        changed=copy.deepcopy(entry);changed['nativeSpan']['markers'][1]['sequence']=20
        self.assertIsNone(self.observe(state,changed,io,context))
        changed=copy.deepcopy(entry);changed['nativeSpan']['markers'][0]['entry']=200
        self.assertIsNone(self.observe(state,changed,io,context))
        changed=copy.deepcopy(io);changed[2]['nativeBracket']['entry']='220';changed[2]['nativeBracket']['return']='221'
        self.assertIsNone(self.observe(state,entry,changed,context))
        changed=copy.deepcopy(io);changed[2]['nativeBracket']['childPid']=True
        self.assertIsNone(self.observe(state,entry,changed,context))
        changed=copy.deepcopy(entry);changed['native']['columns']=200
        self.assertIsNone(self.observe(state,changed,io,context))

    def test_zero_observation_inside_resize_binds_old_layout_without_becoming_a_paint(self):
        _, entry, io, context = self.fixture()
        logical = copy.deepcopy(entry)
        logical['frameId'] = logical['native']['spanId'] = 2
        logical['rawStart'] = logical['rawEnd'] = 12
        logical['writeSequences'] = logical['nativeSpan']['writes'] = []
        logical['outputBase64'] = ''
        logical['nativeSpan'].update(observationKind='logical-observation', layoutRawStart=12, layoutWriteSequences=[22])
        logical['physicalBoundary'] = 'native-pre-layout-observation-v1'
        for marker in logical['nativeSpan']['markers']:
            marker['sequence'] += 5
            marker['entry'], marker['return'] = str(int(marker['entry'])+100), str(int(marker['return'])+100)
        ack = copy.deepcopy(io[2])
        ack.update(ioId=len(io)+1, geometryId=2, rawOffset=12, columns=109)
        ack['nativeBracket'].update(entry='305', **{'return':'306'},
             beforeSizeHex=struct.pack('HHHH',34,110,0,0).hex(), afterSizeHex=struct.pack('HHHH',34,109,0,0).hex())
        io.append(ack)
        result = driver.canonical_native_frame_binding(logical, [entry,logical], io, context)
        self.assertIsNotNone(result)
        self.assertEqual((result['geometryId'], result['outputSourceFrameId']), (1, 1))
        self.assertEqual(result['physicalBoundary'], 'native-pre-layout-observation-v1')
        for field, bad in [('layoutRawStart', 11), ('layoutRawStart', True),
                           ('layoutWriteSequences', [26]), ('layoutWriteSequences', [22,22])]:
            changed = copy.deepcopy(logical); changed['nativeSpan'][field] = bad
            self.assertIsNone(driver.canonical_native_frame_binding(changed, [entry,changed], io, context))
        changed = copy.deepcopy(logical); changed['physicalBoundary'] = 'native-frame-end-v1'
        self.assertIsNone(driver.canonical_native_frame_binding(changed, [entry,changed], io, context))
        ack['nativeBracket'].update(entry='300', **{'return':'301'})
        self.assertIsNone(driver.canonical_native_frame_binding(logical, [entry,logical], io, context))

    def test_zero_output_after_real_resize_cannot_borrow_old_geometry(self):
        state, entry, io, context=self.fixture()
        entry['rawStart']=entry['rawEnd']=9;entry['writeSequences']=entry['nativeSpan']['writes']=[]
        entry['outputBase64']='';entry['nativeSpan']['observationKind']='logical-observation'
        entry['native']['columns'],entry['native']['rows']=200,60
        frame=json.loads(base64.b64decode(entry['frameBase64']));frame['columns']=200;frame['viewport']={'width':200,'height':60}
        entry['frameBase64']=base64.b64encode(json.dumps(frame).encode()).decode()
        self.assertIsNone(self.observe(state,entry,io,context))

    def test_action_window_rejects_pre_action_frames_and_later_duplicate_input(self):
        state,entry,io,context=self.fixture()
        action={'kind':'input','receipt':{'phase':'send','transport':'tmux-paste-buffer','hex':'2f646966660d',
          'actionId':2,'lastObservedFrameId':0,'lastObservedIoId':2,'observedRawBytes':9}}
        boundary={'lastObservedFrameId':1,'lastObservedIoId':5,'observedRawBytes':12}
        binding=driver.canonical_native_frame_binding(entry,[entry],io,context)
        self.assertTrue(driver.canonical_native_action_associated(entry,binding,io,action,boundary))
        changed=copy.deepcopy(action);changed['receipt']['observedRawBytes']=13
        self.assertFalse(driver.canonical_native_action_associated(entry,binding,io,changed,boundary))
        changed=copy.deepcopy(boundary);changed['lastObservedIoId']=3
        self.assertFalse(driver.canonical_native_action_associated(entry,binding,io,action,changed))
        changed=copy.deepcopy(io);changed[3]['ioId']=6
        self.assertFalse(driver.canonical_native_action_associated(entry,binding,changed,action,boundary))
        self.assertIs(io[3]['actualOsReadCovered'],False)
        self.assertIs(binding['actualInputOwnerCovered'],False)

    def test_resize_ack_and_frame_before_parent_return_use_send_boundary(self):
        _, entry, io, context = self.fixture()
        binding = driver.canonical_native_frame_binding(entry, [entry], io, context)
        begin = {'phase': 'resize-send', 'actionId': 7, 'columns': 110, 'rows': 34,
                 'lastObservedFrameId': 0, 'lastObservedIoId': 2, 'observedRawBytes': 9}
        receipt = {**begin, 'phase': 'resize-return', 'exitCode': 0,
                   'lastObservedFrameId': 1, 'lastObservedIoId': 5, 'observedRawBytes': 12}
        action = {'kind': 'resize', 'receipt': receipt, 'send': begin}
        boundary = {'lastObservedFrameId': 1, 'lastObservedIoId': 5, 'observedRawBytes': 12}
        self.assertTrue(driver.canonical_native_action_associated(entry, binding, io, action, boundary))
        for field, value in [('actionId', 8), ('actionId', True), ('columns', 109), ('phase', 'resize-return'),
                             ('lastObservedIoId', 3), ('lastObservedFrameId', 1), ('observedRawBytes', 13)]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(action); changed['send'][field] = value
                self.assertFalse(driver.canonical_native_action_associated(entry, binding, io, changed, boundary))
        changed = copy.deepcopy(action); changed.pop('send')
        self.assertFalse(driver.canonical_native_action_associated(entry, binding, io, changed, boundary))
        changed = copy.deepcopy(action); changed['receipt']['exitCode'] = True
        self.assertFalse(driver.canonical_native_action_associated(entry, binding, io, changed, boundary))

    def test_final_rechecks_recorded_frame_despite_a_newer_observed_boundary(self):
        fixture_spec = importlib.util.spec_from_file_location('canonical_fixture',
            SOURCE.parent / '.claude/skills/release-validation/scripts/test-release-driver.py')
        fixtures = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixtures)
        with tempfile.TemporaryDirectory(prefix='canonical-recorded-frame-') as tmp:
            root = Path(tmp).resolve()
            (root / 'debug.log').write_text('')
            fixtures._canonical_ui_fixture(driver, root)
            frames = [json.loads(line) for line in (root / 'frames.jsonl').read_bytes().splitlines()]
            checkpoints = json.loads((root / 'canonical-checkpoints.json').read_text())
            original = copy.deepcopy(frames[-1])
            newer = copy.deepcopy(original)
            newer['frameId'] += 1
            frames.append(newer)
            checkpoints[-1]['lastObservedFrameId'] = newer['frameId']
            (root / 'frames.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in frames))
            (root / 'canonical-checkpoints.json').write_text(json.dumps(checkpoints))
            self.assertTrue(all(driver.canonical_ui_checks(root).values()))
            # A later valid frame must never hide a bad recorded observation.
            frames[-2]['terminalUiRevision'] -= 1
            (root / 'frames.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in frames))
            self.assertFalse(all(driver.canonical_ui_checks(root).values()))

    def test_real_input_producer_creates_private_immutable_receipts(self):
        from unittest.mock import Mock
        gate = object.__new__(driver.BinaryGate)
        gate.pid, gate.session_index = 17, 1
        gate.tmux = Mock()
        with tempfile.TemporaryDirectory(prefix='canonical-input-producer-') as tmp:
            root = Path(tmp).resolve()
            data = b'/diff\r'
            before = os.umask(0o022)
            try:
                gate.paste_bytes('unit:0.0', root, data, 'raw-private-input.bin')
            finally:
                os.umask(before)
            path = root / 'raw-private-input.bin'
            receipt = {'phase': 'send', 'transport': 'tmux-paste-buffer',
                       'inputFile': str(path), 'hex': data.hex(), 'bytesSHA256': driver.sha256(path)}
            self.assertTrue(driver.canonical_input_file_matches(root, receipt, native=True))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            held = path.read_bytes()
            with self.assertRaises(FileExistsError):
                gate.paste_bytes('unit:0.0', root, b'changed', path.name)
            self.assertEqual(path.read_bytes(), held)
            alias = root / 'raw-alias-input.bin'
            alias.symlink_to(path)
            with self.assertRaises(FileExistsError):
                gate.paste_bytes('unit:0.0', root, b'changed', alias.name)
            self.assertEqual(path.read_bytes(), held)

    def test_failed_write_then_success_keeps_original_errno_and_zero_prefix(self):
        _, entry, io, context = self.fixture()
        entry['nativeSpan']['markers'][2]['sequence'] = 24
        entry['nativeSpan']['markers'][3]['sequence'] = 25
        entry['nativeSpan']['writes'][0]['sequence'] = 23
        entry['nativeSpan']['writes'].insert(0, {'sequence': 22, 'entry': '215', 'return': '216',
            'result': -1, 'errno': 35, 'outputBytes': 0})
        entry['writeSequences'] = [22, 23]
        self.assertIsNotNone(driver.canonical_native_frame_binding(entry, [entry], io, context))
        entry['nativeSpan']['writes'][1]['errno'] = 4
        self.assertIsNotNone(driver.canonical_native_frame_binding(entry, [entry], io, context))
        for field, value in [('result', -2), ('result', True), ('errno', 0), ('errno', True), ('outputBytes', 1)]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(entry)
                changed['nativeSpan']['writes'][0][field] = value
                self.assertIsNone(driver.canonical_native_frame_binding(changed, [changed], io, context))

    def test_fragmented_input_is_unique_inside_the_action_window(self):
        _, entry, io, context = self.fixture()
        first = {**io[3], 'hex': '2f6469'}
        second = {**io[3], 'hex': '66660d'}
        fragmented = [*io[:3], first, second, io[4]]
        for index, row in enumerate(fragmented, 1): row['ioId'] = index
        action = {'kind': 'input', 'receipt': {'phase': 'send', 'transport': 'tmux-paste-buffer',
            'hex': '2f646966660d', 'lastObservedFrameId': 0, 'lastObservedIoId': 2, 'observedRawBytes': 9}}
        boundary = {'lastObservedFrameId': 1, 'lastObservedIoId': 6, 'observedRawBytes': 12}
        binding = driver.canonical_native_frame_binding(entry, [entry], fragmented, context)
        self.assertTrue(driver.canonical_native_action_associated(entry, binding, fragmented, action, boundary))
        cleanup = {**first, 'ioId': 7, 'hex': action['receipt']['hex'], 'rawOffset': 12}
        self.assertTrue(driver.canonical_native_action_associated(entry, binding, [*fragmented, cleanup], action, boundary))
        duplicated = [*fragmented[:5], {**first, 'ioId': 6, 'hex': action['receipt']['hex']}, {**fragmented[5], 'ioId': 7}]
        boundary['lastObservedIoId'] = 7
        self.assertFalse(driver.canonical_native_action_associated(entry, binding, duplicated, action, boundary))

    def test_input_file_must_be_owned_regular_and_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / 'raw-input.bin'
            path.write_bytes(b'/diff\r'); path.chmod(0o600)
            receipt = {'phase': 'send', 'transport': 'tmux-paste-buffer', 'inputFile': str(path),
                       'hex': '2f646966660d', 'bytesSHA256': driver.sha256(path)}
            self.assertTrue(driver.canonical_input_file_matches(root, receipt, True))
            path.write_bytes(b'/help\r')
            self.assertFalse(driver.canonical_input_file_matches(root, receipt, True))
            path.write_bytes(b'/diff\r'); path.chmod(0o644)
            self.assertFalse(driver.canonical_input_file_matches(root, receipt, True))
            path.unlink(); os.mkfifo(path, 0o600)
            self.assertFalse(driver.canonical_input_file_matches(root, receipt, True))

    def test_host_context_uses_owned_bounded_header_and_launch_identity(self):
        _,_,_,context=self.fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();launch={'run':str(root),'binarySha256':'b'*64,'capture':{
                'captureId':'unit-capture','nativeJournal':True,'initialSize':{'columns':200,'rows':60}}}
            start=root/'start.json';start.write_text(json.dumps({'childPid':789,'childPgid':789,'binarySha256':'b'*64}));start.chmod(0o600)
            header=[0]*32;header[:6]=[0x314C4E4A544343,1,256,4288,64,4096];header[6:8]=[int('a'*16,16)]*2
            header[8],header[12],header[13],header[19]=789,125,3,50
            path=root/'journal.bin'
            with path.open('wb') as output:output.write(struct.pack('<32Q',*header));output.truncate(256+4288*64)
            path.chmod(0o600)
            self.assertEqual(driver.canonical_native_context(root,launch,'b'*64),context)
            self.assertIsNone(driver.canonical_native_context(root,launch,None))
            for changes in ({'childPid': True}, {'childPgid': True}, {'binarySha256': 'c'*64}):
                start.write_text(json.dumps({'childPid': 789, 'childPgid': 789, 'binarySha256': 'b'*64, **changes}))
                self.assertIsNone(driver.canonical_native_context(root, launch, 'b'*64))
            start.write_text(json.dumps({'childPid': 789, 'childPgid': 789, 'binarySha256': 'b'*64}))
            original = path.read_bytes()
            path.write_bytes(original[:255])
            self.assertIsNone(driver.canonical_native_context(root, launch, 'b'*64))
            path.write_bytes(original)
            path.chmod(0o644)
            self.assertIsNone(driver.canonical_native_context(root, launch, 'b'*64))
            path.chmod(0o600)
            wrong=copy.deepcopy(launch);wrong['run']=str(root/'foreign')
            self.assertIsNone(driver.canonical_native_context(root,wrong,'b'*64))
            path.unlink();os.mkfifo(path,0o600)
            self.assertIsNone(driver.canonical_native_context(root,launch,'b'*64))


if __name__=='__main__':unittest.main()
