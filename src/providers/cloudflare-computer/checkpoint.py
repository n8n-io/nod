import argparse
import hashlib
import heapq
import hmac
import json
import os
import re
import secrets
import stat
import sys
import tarfile
import zlib


LIMITS = {
    "max_bytes": 1024 * 1024 * 1024,
    "max_file_bytes": 512 * 1024 * 1024,
    "max_entries": 100000,
    "max_path_bytes": 4096,
}
ERROR = b"Computer checkpoint failed.\n"
SKIPPED = frozenset(("__pycache__", ".cache"))
BROWSER_CACHES = frozenset((
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "component_crx_cache",
    "extensions_crx_cache",
))
LEVEL = 1
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
BLOCK = 512


class Failure(Exception):
    pass


class TooLarge(Exception):
    def __init__(self, report):
        super().__init__()
        self.report = report


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Failure()


def require(condition):
    if not condition:
        raise Failure()


def signature(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def path_parts(value, limit, root=False):
    require(isinstance(value, str) and "\0" not in value)
    require(0 < len(value.encode("utf-8")) <= limit)
    if root and value == ".":
        return ()
    require(not value.startswith("/"))
    parts = tuple(value.split("/"))
    require(all(part not in ("", ".", "..") for part in parts))
    return parts


def open_directory(base, parts):
    current = os.dup(base)
    try:
        for part in parts:
            following = os.open(part, DIRECTORY, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def open_parent(value):
    require(isinstance(value, str) and "\0" not in value)
    parts = value.split("/")
    require(parts[-1] not in ("", ".", ".."))
    require(all(part != ".." for part in parts))
    base = os.open("/" if value.startswith("/") else ".", DIRECTORY)
    try:
        parent = open_directory(base, tuple(part for part in parts[:-1] if part not in ("", ".")))
        return parent, parts[-1]
    finally:
        os.close(base)


def link_target(value, limit):
    require(isinstance(value, str) and "\0" not in value)
    require(0 < len(value.encode("utf-8")) <= limit)
    return None if value.startswith("/") else tuple(value.split("/"))


def validate_links(entries, limit):
    def resolve(parts, active):
        current = ()
        for part in parts:
            if part in ("", "."):
                continue
            if part == "..":
                require(bool(current))
                current = current[:-1]
                continue
            require(entries.get(current, ("directory",))[0] == "directory")
            candidate = current + (part,)
            entry = entries.get(candidate)
            if entry and entry[0] == "symlink":
                target = link_target(entry[1], limit)
                require(candidate not in active and target is not None)
                current = resolve(current + target, active | {candidate})
            else:
                current = candidate
        return current

    graph = {path: [] for path, entry in entries.items() if entry[0] == "directory"}
    for path, entry in entries.items():
        if path and entry[0] == "directory":
            graph[path[:-1]].append(path)
        if entry[0] == "symlink":
            target = link_target(entry[1], limit)
            destination = None if target is None else resolve(path[:-1] + target, {path})
            if entries.get(destination, (None,))[0] == "directory":
                graph[path[:-1]].append(destination)
    colors = {}
    for start in graph:
        if colors.get(start) == 2:
            continue
        pending = [(start, False)]
        while pending:
            path, leaving = pending.pop()
            if leaving:
                colors[path] = 2
                continue
            require(colors.get(path) != 1)
            if colors.get(path) == 2:
                continue
            colors[path] = 1
            pending.append((path, True))
            pending.extend((child, False) for child in graph[path])


class Output:
    def __init__(self, maximum):
        self.maximum = maximum
        self.total = 0
        self.compressor = zlib.compressobj(LEVEL, zlib.DEFLATED, 31)

    def write(self, data):
        require(self.total + len(data) <= self.maximum)
        self.total += len(data)
        self.emit(self.compressor.compress(data))

    def finish(self):
        self.emit(self.compressor.flush())

    def emit(self, data):
        remaining = memoryview(data)
        while remaining:
            written = os.write(1, remaining)
            require(written > 0)
            remaining = remaining[written:]


class Input:
    def __init__(self, maximum):
        self.maximum = maximum
        self.total = 0
        self.raw_maximum = compressed_limit(maximum)
        self.raw_total = 0
        self.digest = hashlib.sha256()
        self.pending = bytearray()
        self.tail = b""
        self.inflater = None
        self.ended = False
        head = bytearray()
        while len(head) < 2:
            data = self.raw(2 - len(head))
            if not data:
                break
            head += data
        if head == b"\x1f\x8b":
            self.inflater = zlib.decompressobj(31)
            self.tail = bytes(head)
        else:
            self.accept(head)

    def raw(self, length=65536):
        data = os.read(0, min(length, max(1, self.raw_maximum - self.raw_total + 1)))
        self.raw_total += len(data)
        require(self.raw_total <= self.raw_maximum)
        self.digest.update(data)
        return data

    def accept(self, data):
        self.total += len(data)
        require(self.total <= self.maximum)
        self.pending += data

    def more(self):
        if self.ended:
            return False
        if self.inflater is None:
            data = self.raw()
            self.accept(data)
            self.ended = not data
            return bool(data)
        while not self.inflater.eof:
            data = self.tail or self.raw()
            require(bool(data))
            output = self.inflater.decompress(data, 65536)
            self.tail = self.inflater.unconsumed_tail
            if output:
                self.accept(output)
                return True
        require(not self.tail and not self.inflater.unused_data and not self.raw(1))
        self.ended = True
        return False

    def read(self, length):
        while not self.pending and self.more():
            pass
        data = bytes(self.pending[:length])
        del self.pending[:length]
        return data

    def exact(self, length):
        result = bytearray()
        while len(result) < length:
            data = self.read(length - len(result))
            require(bool(data))
            result.extend(data)
        return bytes(result)

    def padding(self, length):
        padding = (-length) % BLOCK
        if padding:
            require(self.exact(padding) == bytes(padding))

    def finish(self):
        require(self.exact(BLOCK) == bytes(BLOCK))
        while True:
            data = self.read(65536)
            if not data:
                break
            require(not any(data))
        require(self.total % BLOCK == 0)


def compressed_limit(maximum):
    return maximum + maximum // 1000 + 65536


class Usage:
    def __init__(self, options):
        self.options = options
        self.bytes = 3 * BLOCK
        self.entries = 0
        self.largest = []
        self.complete = True

    def add(self, path, entry):
        kind, target, details = entry
        name = "/".join(path) + ("/" if kind == "directory" else "")
        records = 90 if kind == "file" else 0
        if len(name) > 99 or not name.isascii():
            records += len(name.encode("utf-8")) + 30
        if kind == "symlink" and (len(target) > 99 or not target.isascii()):
            records += len(target.encode("utf-8")) + 30
        self.bytes += BLOCK + (BLOCK + -(-records // BLOCK) * BLOCK if records else 0)
        self.entries += 1
        if kind == "file":
            self.bytes += -(-details.st_size // BLOCK) * BLOCK
            item = (details.st_size, "/".join(path))
            if len(self.largest) < 5:
                heapq.heappush(self.largest, item)
            else:
                heapq.heappushpop(self.largest, item)
        if self.entries > self.options.max_entries * 5:
            self.complete = False
            raise TooLarge(self.report())

    def check(self):
        options = self.options
        if (
            self.bytes > options.max_bytes
            or self.entries + 1 > options.max_entries
            or any(size > options.max_file_bytes for size, _ in self.largest)
        ):
            raise TooLarge(self.report())

    def report(self):
        options = self.options
        return {
            "bytes": self.bytes,
            "max_bytes": options.max_bytes,
            "entries": self.entries,
            "max_entries": options.max_entries,
            "max_file_bytes": options.max_file_bytes,
            "complete": self.complete,
            "largest": [[path, size] for size, path in sorted(self.largest, reverse=True)],
        }


def collect(root, options):
    skipped = SKIPPED | (BROWSER_CACHES if options.browser else frozenset())
    entries = {(): ("directory", None, os.fstat(root))}
    usage = Usage(options)
    pending = [()]
    while pending:
        path = pending.pop()
        descriptor = open_directory(root, path)
        try:
            require(signature(os.fstat(descriptor)) == signature(entries[path][2]))
            with os.scandir(descriptor) as iterator:
                for item in iterator:
                    child = path + (item.name,)
                    path_parts("/".join(child), options.max_path_bytes)
                    details = os.stat(item.name, dir_fd=descriptor, follow_symlinks=False)
                    if stat.S_ISDIR(details.st_mode):
                        if item.name in skipped:
                            continue
                        entries[child] = ("directory", None, details)
                        pending.append(child)
                    elif stat.S_ISREG(details.st_mode):
                        entries[child] = ("file", None, details)
                    elif stat.S_ISLNK(details.st_mode):
                        target = os.readlink(item.name, dir_fd=descriptor)
                        link_target(target, options.max_path_bytes)
                        entries[child] = ("symlink", target, details)
                    else:
                        continue
                    usage.add(child, entries[child])
        finally:
            os.close(descriptor)
    usage.check()
    validate_links(entries, options.max_path_bytes)
    return entries


def metadata(path, entry):
    kind, target, details = entry
    member = tarfile.TarInfo("/".join(path) if path else ".")
    member.mode = stat.S_IMODE(details.st_mode) & 0o777
    member.mtime = max(0, int(details.st_mtime))
    if kind == "directory":
        member.type = tarfile.DIRTYPE
    elif kind == "symlink":
        member.type = tarfile.SYMTYPE
        member.linkname = target
    else:
        member.size = details.st_size
    return member


def write_file(root, path, entry, output):
    parent = open_directory(root, path[:-1])
    descriptor = None
    try:
        descriptor = os.open(path[-1], REGULAR, dir_fd=parent)
        expected = signature(entry[2])
        require(stat.S_ISREG(os.fstat(descriptor).st_mode))
        require(signature(os.fstat(descriptor)) == expected)
        digest = hashlib.sha256()
        remaining = entry[2].st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            require(bool(chunk))
            digest.update(chunk)
            remaining -= len(chunk)
        require(not os.read(descriptor, 1) and signature(os.fstat(descriptor)) == expected)
        member = metadata(path, entry)
        member.pax_headers = {"otto.sha256": digest.hexdigest()}
        output.write(member.tobuf(format=tarfile.PAX_FORMAT))
        os.lseek(descriptor, 0, os.SEEK_SET)
        captured = hashlib.sha256()
        remaining = entry[2].st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            require(bool(chunk))
            captured.update(chunk)
            output.write(chunk)
            remaining -= len(chunk)
        require(not os.read(descriptor, 1) and captured.digest() == digest.digest())
        require(signature(os.fstat(descriptor)) == expected)
        require(signature(os.stat(path[-1], dir_fd=parent, follow_symlinks=False)) == expected)
        output.write(bytes((-entry[2].st_size) % BLOCK))
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def create(root, options):
    entries = collect(root, options)
    output = Output(options.max_bytes)
    for path in sorted(entries):
        entry = entries[path]
        if entry[0] == "file":
            write_file(root, path, entry, output)
        else:
            output.write(metadata(path, entry).tobuf(format=tarfile.PAX_FORMAT))
    for path, entry in entries.items():
        parent = open_directory(root, path[:-1]) if path else os.dup(root)
        try:
            current = os.stat(path[-1], dir_fd=parent, follow_symlinks=False) if path else os.fstat(root)
            require(signature(current) == signature(entry[2]))
            if entry[0] == "symlink":
                require(os.readlink(path[-1], dir_fd=parent) == entry[1])
        finally:
            os.close(parent)
    output.write(bytes(BLOCK * 2))
    output.finish()


def pax_headers(data):
    result = {}
    while data:
        offset = data.find(b" ")
        require(0 < offset < 10 and re.fullmatch(rb"[1-9][0-9]*", data[:offset]))
        length = int(data[:offset])
        require(offset + 3 <= length <= len(data) and data[length - 1] == 10)
        value = data[offset + 1:length - 1].decode("utf-8")
        key, separator, text = value.partition("=")
        require(separator and key in ("path", "linkpath", "otto.sha256"))
        require(key not in result and text and "\0" not in text)
        result[key] = text
        data = data[length:]
    return result


def extract(root, options):
    source = Input(options.max_bytes)
    entries = {}
    directories = []
    links = []
    extended = None
    while True:
        header = source.exact(BLOCK)
        if header == bytes(BLOCK):
            require(extended is None and () in entries)
            source.finish()
            break
        require(header[257:263] == b"ustar\0")
        member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        require(member.size >= 0)
        if member.type == tarfile.XHDTYPE:
            require(extended is None and 0 < member.size <= 16384)
            extended = pax_headers(source.exact(member.size))
            source.padding(member.size)
            continue
        require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE))
        fields = extended or {}
        extended = None
        name = fields.get("path", member.name)
        if member.type == tarfile.DIRTYPE and name.endswith("/"):
            name = name[:-1]
        path = path_parts(name, options.max_path_bytes, root=True)
        require(path not in entries and len(entries) < options.max_entries)
        require(path or member.type == tarfile.DIRTYPE)
        require(not entries or path)
        require(not path or entries.get(path[:-1], (None,))[0] == "directory")
        require("linkpath" not in fields or member.type == tarfile.SYMTYPE)
        require(not member.linkname or member.type == tarfile.SYMTYPE)
        regular = member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)
        require(regular or (member.size == 0 and "otto.sha256" not in fields))
        require(member.mode >= 0 and member.mtime >= 0)
        mode = member.mode & 0o777
        if member.type == tarfile.DIRTYPE:
            if path:
                parent = open_directory(root, path[:-1])
                try:
                    os.mkdir(path[-1], 0o700, dir_fd=parent)
                finally:
                    os.close(parent)
            entries[path] = ("directory", None)
            directories.append((path, mode, member.mtime))
        elif member.type == tarfile.SYMTYPE:
            target = fields.get("linkpath", member.linkname)
            link_target(target, options.max_path_bytes)
            entries[path] = ("symlink", target)
            links.append((path, target))
        else:
            expected = fields.get("otto.sha256", "")
            require(re.fullmatch(r"[0-9a-f]{64}", expected))
            require(member.size <= options.max_file_bytes and not member.linkname)
            parent = open_directory(root, path[:-1])
            descriptor = None
            try:
                descriptor = os.open(path[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                digest = hashlib.sha256()
                remaining = member.size
                while remaining:
                    chunk = source.exact(min(remaining, 65536))
                    digest.update(chunk)
                    pending = memoryview(chunk)
                    while pending:
                        written = os.write(descriptor, pending)
                        require(written > 0)
                        pending = pending[written:]
                    remaining -= len(chunk)
                require(hmac.compare_digest(digest.hexdigest(), expected))
                source.padding(member.size)
                os.fchmod(descriptor, mode)
                os.utime(descriptor, (member.mtime, member.mtime))
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                os.close(parent)
            entries[path] = ("file", None)
    if options.sha256 is not None:
        require(hmac.compare_digest(source.digest.hexdigest(), options.sha256))
    validate_links(entries, options.max_path_bytes)
    for path, target in links:
        parent = open_directory(root, path[:-1])
        try:
            os.symlink(target, path[-1], dir_fd=parent)
        finally:
            os.close(parent)
    for path, mode, modified in sorted(directories, key=lambda item: len(item[0]), reverse=True):
        descriptor = open_directory(root, path)
        try:
            os.fchmod(descriptor, mode)
            os.utime(descriptor, (modified, modified))
        finally:
            os.close(descriptor)


def remove_tree(parent, name):
    descriptor = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        os.fchmod(descriptor, 0o700)
        for child in os.listdir(descriptor):
            details = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(details.st_mode):
                os.chmod(child, 0o700, dir_fd=descriptor, follow_symlinks=False)
                remove_tree(descriptor, child)
            else:
                os.unlink(child, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=parent)


def empty_target(parent, name):
    try:
        descriptor = os.open(name, DIRECTORY, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        require(not os.listdir(descriptor))
        return signature(os.fstat(descriptor))
    finally:
        os.close(descriptor)


def restore(parent, name, options):
    original = empty_target(parent, name)
    staging = ".otto-checkpoint-" + secrets.token_hex(16)
    os.mkdir(staging, 0o700, dir_fd=parent)
    descriptor = None
    try:
        descriptor = os.open(staging, DIRECTORY, dir_fd=parent)
        extract(descriptor, options)
        os.sync()
        require(empty_target(parent, name) == original)
        os.rename(staging, name, src_dir_fd=parent, dst_dir_fd=parent)
        staging = None
    finally:
        if descriptor is not None:
            if staging is not None:
                os.fchmod(descriptor, 0o700)
            os.close(descriptor)
        if staging is not None:
            remove_tree(parent, staging)


def main():
    parser = Parser(add_help=False)
    parser.add_argument("operation", choices=("create", "restore"))
    parser.add_argument("root")
    for name, maximum in LIMITS.items():
        parser.add_argument("--" + name.replace("_", "-"), type=int, default=maximum)
    parser.add_argument("--sha256")
    parser.add_argument("--browser", action="store_true")
    options = parser.parse_args()
    for name, maximum in LIMITS.items():
        require(0 < getattr(options, name) <= maximum)
    require(options.sha256 is None or (options.operation == "restore" and re.fullmatch(r"[0-9a-f]{64}", options.sha256)))
    require(not options.browser or options.operation == "create")
    os.umask(0o077)
    parent, name = open_parent(options.root)
    try:
        if options.operation == "create":
            descriptor = os.open(name, DIRECTORY, dir_fd=parent)
            try:
                create(descriptor, options)
            finally:
                os.close(descriptor)
        else:
            restore(parent, name, options)
    finally:
        os.close(parent)


if __name__ == "__main__":
    try:
        main()
    except TooLarge as error:
        os.write(2, json.dumps(error.report).encode("utf-8") + b"\n")
        os._exit(0)
    except (Exception, KeyboardInterrupt):
        try:
            os.write(2, ERROR)
        finally:
            os._exit(1)
