"""Publish copied native/PTY prefixes without disk waits in the capture loop.

Only final, closed originals establish completeness. Overflow or publication
failure invalidates capture; neither waits for a product acknowledgement.
"""
import json
import os
from pathlib import Path
import queue
import stat
import threading


def rows_bytes(rows):
    return b''.join((json.dumps(row) + '\n').encode() for row in rows)


class NativeLivePublisher:
    def __init__(self, run, journal, registration, pid, capture_id, output_flags,
                 limit=64 * 1024 * 1024):
        self.run, self.journal = Path(run), journal
        self.registration = json.loads(json.dumps(registration))
        self.pid, self.capture_id, self.output_flags = pid, capture_id, output_flags
        self.limit, self.queued, self.retained = limit, 0, 0
        self.queue, self.lock = queue.Queue(), threading.Lock()
        self.closing = threading.Event()
        self.error = self.expected = None
        self.frames, self.packets, self.io = [], [], []
        self.raw, self.header = bytearray(), None
        self.has_snapshot = False
        self.thread = threading.Thread(target=self._run, name='native-prefix-writer', daemon=True)
        self.thread.start()

    def offer(self, kind, value, header=None):
        # The owner supplies immutable copies; the writer never touches mmap.
        if type(value) is not bytes or kind not in ('packet', 'raw', 'io'):
            raise ValueError('Immutable native publication item required')
        header = tuple(header) if header is not None else None
        size = len(value) + 256
        with self.lock:
            if self.closing.is_set() or self.error is not None:
                return False
            if self.queued + self.retained + size > self.limit:
                self.error = ValueError('Bounded live publication lost evidence')
                return False
            self.queued += size
            self.queue.put_nowait((kind, value, header, size))
        return True

    def finish(self, io, frames, timeout=2):
        with self.lock:
            self.expected = (io, frames)
            self.closing.set()
        self.thread.join(timeout)
        if self.thread.is_alive():
            raise TimeoutError('Native prefix writer did not close within its budget')
        if self.error is not None:
            raise self.error

    def _write(self, fd, data):
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0:
                raise OSError('Native prefix write made no progress')
            offset += count

    def _publish_frames(self, fd):
        if not self.has_snapshot:
            return
        frames = self.journal.ink_live_frame_entries(self.header, self.packets, bytes(self.raw),
            self.registration, self.pid, self.capture_id, self.output_flags)
        if not frames:
            return
        if frames[:len(self.frames)] != self.frames:
            raise ValueError('Published native frame prefix changed')
        self._write(fd, rows_bytes(frames[len(self.frames):]))
        self.frames = frames

    def _verify_file(self, name, fd, expected):
        opened, named = os.fstat(fd), os.lstat(self.run / name)
        if (not stat.S_ISREG(named.st_mode) or named.st_uid != os.getuid() or
                stat.S_IMODE(named.st_mode) != 0o600 or named.st_nlink != 1 or
                (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
            raise ValueError('Native prefix file ownership changed: ' + name)
        os.lseek(fd, 0, os.SEEK_SET)
        actual = bytearray()
        while len(actual) <= len(expected):
            chunk = os.read(fd, min(65536, len(expected) + 1 - len(actual)))
            if not chunk:
                break
            actual.extend(chunk)
        if actual != expected or os.fstat(fd).st_size != len(expected):
            raise ValueError('Native prefix file differs from held originals: ' + name)
        after = os.lstat(self.run / name)
        if (after.st_dev, after.st_ino, after.st_size, after.st_nlink, after.st_mode) != (
                named.st_dev, named.st_ino, len(expected), 1, named.st_mode):
            raise ValueError('Native prefix file changed during close: ' + name)

    def _run(self):
        files = {}
        try:
            for name in ('frames.jsonl', 'pty-io.jsonl'):
                files[name] = os.open(self.run / name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            while True:
                try:
                    kind, value, header, size = self.queue.get(timeout=.02)
                except queue.Empty:
                    if self.closing.is_set():
                        break
                    continue
                if kind == 'packet':
                    self.packets.append(value)
                    self.header = header
                    snapshot = self.journal.RECORD.unpack_from(value)[2] == 11
                    self.has_snapshot |= snapshot
                    if snapshot:
                        self._publish_frames(files['frames.jsonl'])
                elif kind == 'raw':
                    self.raw.extend(value)
                    self._publish_frames(files['frames.jsonl'])
                else:
                    self.io.append(value)
                    self._write(files['pty-io.jsonl'], value)
                with self.lock:
                    self.queued -= size
                    self.retained += size
            if self.error is not None:
                return
            io, frames = self.expected
            if b''.join(self.io) != io or self.frames != frames:
                raise ValueError('Live publication differs from final closed originals')
            self._verify_file('pty-io.jsonl', files['pty-io.jsonl'], io)
            self._verify_file('frames.jsonl', files['frames.jsonl'], rows_bytes(frames))
        except BaseException as error:
            with self.lock:
                if self.error is None:
                    self.error = error
        finally:
            for fd in files.values():
                try:
                    os.close(fd)
                except OSError as error:
                    with self.lock:
                        if self.error is None:
                            self.error = error
