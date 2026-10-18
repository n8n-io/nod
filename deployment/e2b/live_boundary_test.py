import base64
import contextlib
import errno
import importlib.util
import io
import json
import os
import pathlib
import signal
import socket
import types
import unittest
import tempfile
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("live_boundary", pathlib.Path(__file__).with_name("live-boundary.py"))
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


class RoleFixture:
    def __init__(self, allowed=None, fault=None):
        self.allowed = allowed
        self.fault = fault
        self.calls = []
        self.files = {}
        self.targets = [(socket.AF_INET, "127.0.0.1", 0), (socket.AF_INET6, "::1", 0), (socket.AF_INET, "192.0.2.7", 0)]
        self.ports = [19000, 19001, 19002]
        self.browser = (pathlib.Path("/synthetic/profile"), {"DISPLAY": ":107", "XAUTHORITY": "/synthetic/Xauthority"}, object(), "synthetic-browser-cdp", 19003)
        self.denials = [f"os.open('/synthetic/private-{index}',os.O_RDONLY)" for index in range(13)]
        self.directories = {"workspace": pathlib.Path("/synthetic/workspace"), "connected": pathlib.Path("/synthetic/connected")}

    def run(self, uid, args, timeout=5, extra=None):
        self.calls.append((uid, args, timeout, extra))
        if args[0] == "/usr/bin/xdotool":
            return (0, b"1280 800\n", b"") if uid == 1001 else (1, b"", b"denied")
        if args[0] == "/usr/sbin/nft":
            return 1, b"", b"denied"
        if args[0] != "/usr/bin/python3" or args[2] == self.browser[3]:
            return 0, b"", b""
        allowed = self.allowed

        def private_open(*_args):
            if self.fault == (uid, "private"):
                return 7
            if self.fault == (uid, "missing-private"):
                raise FileNotFoundError(errno.ENOENT, "synthetic")
            raise PermissionError(errno.EACCES if uid == 1000 else errno.EPERM, "synthetic")

        def write_text(path, value):
            self.files[str(path)] = value
            return len(value)

        def read_text(path):
            if str(path) == "/proc/self/status":
                effective = "1" if self.fault == (uid, "privileges") else "0"
                return f"NoNewPrivs:\t1\nCapEff:\t{effective}\nCapPrm:\t0\nCapAmb:\t0\nCapInh:\t0\n"
            if self.fault == (uid, "files"):
                return "synthetic-corruption"
            return self.files[str(path)]

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def settimeout(self, _value):
                pass

            def connect(self, target):
                if (uid in (1000, 1002) or (uid, target[1]) == (1001, 49983)) and (uid, target[1]) != allowed:
                    raise PermissionError(errno.EACCES, "synthetic")

            def recv(self, _size):
                return b"otto-live-boundary"

            def close(self):
                pass

        try:
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(socket, "socket", return_value=Connection()))
                stack.enter_context(patch.object(socket, "getaddrinfo", return_value=[] if self.fault == (uid, "dns") else [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.8", 443))]))
                stack.enter_context(patch.object(os, "open", side_effect=private_open))
                stack.enter_context(patch.object(os, "getuid", return_value=uid))
                stack.enter_context(patch.object(os, "getgid", return_value=uid))
                stack.enter_context(patch.object(os, "getgroups", return_value=[]))
                stack.enter_context(patch.dict(os.environ, boundary.environment(uid), clear=True))
                stack.enter_context(patch.object(pathlib.Path, "read_text", read_text))
                stack.enter_context(patch.object(pathlib.Path, "write_text", write_text))
                exec(args[2], {})
        except (AssertionError, OSError):
            return 1, b"", b"synthetic-denial-failure"
        return 0, b"", b""

    def probe(self, processes):
        return boundary.check_restricted_roles(processes, self.targets, self.ports, self.browser, self.denials, self.directories)


class BoundaryTests(unittest.TestCase):
    def test_actual_interfaces_without_added_metadata_addresses(self):
        targets, counts = boundary.addresses(json.dumps([
            {"ifindex": 1, "addr_info": [{"local": "127.0.0.1"}, {"local": "::1"}]},
            {"ifindex": 2, "addr_info": [{"local": "192.0.2.7"}]},
        ]))
        self.assertEqual(targets, [(socket.AF_INET, "127.0.0.1", 0), (socket.AF_INET6, "::1", 0), (socket.AF_INET, "192.0.2.7", 0)])
        self.assertEqual(counts, {4: 1, 6: 0})

    def test_ipv6_link_local_targets_keep_the_interface_scope(self):
        targets, counts = boundary.addresses(json.dumps([
            {"ifindex": 3, "addr_info": [{"local": "fe80::1"}, {"local": "2001:db8::1"}]},
            {"ifindex": 4, "addr_info": [{"local": "fe80::1"}, {"local": "2001:db8::1"}]},
        ]))
        self.assertEqual(targets[2:], [(socket.AF_INET6, "fe80::1", 3), (socket.AF_INET6, "2001:db8::1", 0), (socket.AF_INET6, "fe80::1", 4)])
        self.assertEqual(counts, {4: 0, 6: 3})

    def test_excessive_and_unusable_targets_fail_closed(self):
        values = [
            [{"ifindex": 2, "addr_info": [{"local": "192.0.2." + str(index)} for index in range(1, 18)]}],
            [{"ifindex": 2, "addr_info": [{"local": "0.0.0.0"}]}],
            [{"ifindex": 2, "addr_info": [{"local": "ff02::1"}]}],
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(boundary.BoundaryFailure):
                boundary.addresses(json.dumps(value))

    def test_envd_positive_opens_tcp_without_any_protocol_payload(self):
        calls = []

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                calls.append("close")

            def settimeout(self, value):
                calls.append(("timeout", value))

            def connect(self, target):
                calls.append(("connect", target))

        source = boundary.tcp_source((socket.AF_INET, "127.0.0.1", 0), 49983)
        with patch.object(socket, "socket", return_value=Connection()):
            exec(source, {})
        self.assertEqual(calls, [("timeout", 2), ("connect", ("127.0.0.1", 49983)), "close"])

    def test_denial_does_not_accept_a_missing_private_path(self):
        for code in [errno.EACCES, errno.EPERM]:
            exec(boundary.denial_source(f"raise OSError({code},'synthetic')"), {})
        for code in [errno.ENOENT, errno.EIO]:
            with self.assertRaises(AssertionError):
                exec(boundary.denial_source(f"raise OSError({code},'synthetic')"), {})
        with self.assertRaises(AssertionError):
            exec(boundary.denial_source("pass"), {})

    def test_network_timeout_is_not_accepted_as_a_denial(self):
        class Connection:
            def settimeout(self, _value):
                pass

            def connect(self, _target):
                raise TimeoutError()

            def close(self):
                pass

        source = boundary.tcp_source((socket.AF_INET6, "::1", 0), 19000, denied=True)
        with patch.object(socket, "socket", return_value=Connection()), self.assertRaises(AssertionError):
            exec(source, {})

    def test_child_environment_does_not_inherit_operator_values(self):
        for uid, home in [(1000, "/home/node"), (1002, "/home/otto-connected")]:
            with self.subTest(uid=uid), patch.dict("os.environ", {"E2B_API_KEY": "synthetic-private-key", "HOME": "/root"}):
                value = boundary.environment(uid)
            self.assertEqual(value, {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin", "HOME": home, "LANG": "C.UTF-8"})

    def test_all_restricted_roles_run_the_full_matrix_and_keep_separate_receipts(self):
        fixture = RoleFixture()
        processes = boundary.Processes()
        with patch.object(processes, "run", side_effect=fixture.run), patch.object(processes, "running", return_value=True):
            result = fixture.probe(processes)
        self.assertEqual(set(result), {"workspace", "connected"})
        self.assertEqual(fixture.files, {str(path / "sentinel"): "otto-live-boundary" for path in fixture.directories.values()})
        expected_tcp = []
        for role, uid in [("workspace", 1000), ("connected", 1002)]:
            self.assertEqual(result[role], {"uid": uid, "networkDenied": 5, "privateDenied": 13, "firewallDenied": True, "x11Denied": True, "privilegeDenied": True, "internetDnsFiles": True})
            calls = [call for call in fixture.calls if call[0] == uid]
            python = [call[1][2] for call in calls if call[1][0] == "/usr/bin/python3"]
            self.assertEqual(len(python), 20)
            for target, port in zip(fixture.targets, fixture.ports):
                self.assertIn(boundary.tcp_source(target, port, denied=True), python)
                expected_tcp.extend([(1001, boundary.tcp_source(target, port, marker=True)), (uid, boundary.tcp_source(target, port, denied=True)), (1001, boundary.tcp_source(target, port, marker=True))])
            envd = (socket.AF_INET, "127.0.0.1", 0)
            expected_tcp.extend([(0, boundary.tcp_source(envd, 49983)), (1001, boundary.tcp_source(envd, 49983, denied=True)), (uid, boundary.tcp_source(envd, 49983, denied=True)), (0, boundary.tcp_source(envd, 49983)), (1001, boundary.tcp_source(envd, 49983, denied=True)), (uid, boundary.tcp_source(envd, 19003, denied=True))])
            for port in [49983, 19003]:
                self.assertIn(boundary.tcp_source((socket.AF_INET, "127.0.0.1", 0), port, denied=True), python)
            for operation in fixture.denials:
                self.assertIn(boundary.denial_source(operation), python)
            self.assertTrue(any(f"({uid},{uid},[])" in source and repr(boundary.environment(uid)["HOME"]) in source and "NoNewPrivs" in source and "CapInh" in source for source in python))
            self.assertTrue(any(str(fixture.directories[role]) in source and "getaddrinfo" in source for source in python))
            self.assertTrue(any(call[1][0] == "/usr/sbin/nft" for call in calls))
            self.assertTrue(any(call[1][0] == "/usr/bin/xdotool" for call in calls))
            self.assertTrue(any(call[1][0] == "/usr/bin/curl" and call[1][-1] == "https://example.com" for call in calls))
        actual_tcp = [(call[0], call[1][2]) for call in fixture.calls if call[1][0] == "/usr/bin/python3" and call[1][2].startswith("import errno,socket\n")]
        self.assertEqual(actual_tcp, expected_tcp)
        for index, call in enumerate(fixture.calls):
            if call[1][0] == "/usr/bin/python3" and call[1][2] == boundary.tcp_source((socket.AF_INET, "127.0.0.1", 0), 19003, denied=True):
                for adjacent in [fixture.calls[index - 1], fixture.calls[index + 1]]:
                    self.assertEqual(adjacent[:2], (1001, ["/usr/bin/python3", "-c", "synthetic-browser-cdp"]))

    def test_connected_only_network_escape_fails_after_workspace_success(self):
        for port, label in [(19000, "connected-network"), (49983, "envd-connected"), (19003, "connected-cdp")]:
            fixture = RoleFixture((1002, port))
            processes = boundary.Processes()
            with self.subTest(port=port), patch.object(processes, "run", side_effect=fixture.run), patch.object(processes, "running", return_value=True), self.assertRaisesRegex(boundary.BoundaryFailure, "^" + label + "$"):
                fixture.probe(processes)
            self.assertTrue(any(call[0] == 1000 and call[1][0] == "/usr/bin/curl" for call in fixture.calls))
            self.assertFalse(any(call[0] == 1002 and call[1][0] == "/usr/bin/curl" for call in fixture.calls))

    def test_browser_envd_escape_fails(self):
        fixture = RoleFixture((1001, 49983))
        processes = boundary.Processes()
        with patch.object(processes, "run", side_effect=fixture.run), patch.object(processes, "running", return_value=True), self.assertRaisesRegex(boundary.BoundaryFailure, "^envd-browser$"):
            fixture.probe(processes)

    def test_each_role_executes_private_privilege_file_and_dns_checks(self):
        for role, uid in boundary.RESTRICTED_ROLES:
            for fault, check in [("private", "private"), ("missing-private", "private"), ("privileges", "privileges"), ("files", "files-dns"), ("dns", "files-dns")]:
                fixture = RoleFixture(fault=(uid, fault))
                processes = boundary.Processes()
                with self.subTest(role=role, fault=fault), patch.object(processes, "run", side_effect=fixture.run), patch.object(processes, "running", return_value=True), self.assertRaisesRegex(boundary.BoundaryFailure, "^" + role + "-" + check + "$"):
                    fixture.probe(processes)
                if role == "connected":
                    self.assertTrue(any(call[0] == 1000 and call[1][0] == "/usr/bin/curl" for call in fixture.calls))

    def test_connected_only_command_failures_reject_the_probe(self):
        cases = [
            ("connected-firewall", lambda args: args[0] == "/usr/sbin/nft", (0, b"", b"")),
            ("connected-x11", lambda args: args[0] == "/usr/bin/xdotool", (0, b"1280 800\n", b"")),
            ("connected-https", lambda args: args[0] == "/usr/bin/curl", (1, b"", b"synthetic")),
        ]
        for label, matches, failed in cases:
            fixture = RoleFixture()
            processes = boundary.Processes()

            def run(uid, args, timeout=5, extra=None):
                if uid == 1002 and matches(args):
                    return failed
                return fixture.run(uid, args, timeout, extra)

            with self.subTest(label=label), patch.object(processes, "run", side_effect=run), patch.object(processes, "running", return_value=True), self.assertRaisesRegex(boundary.BoundaryFailure, "^" + label + "$"):
                fixture.probe(processes)
            self.assertTrue(any(call[0] == 1000 and call[1][0] == "/usr/bin/curl" for call in fixture.calls))

    def test_workspace_denial_of_connected_home_and_synthetic_process_has_positive_controls(self):
        processes = boundary.Processes()
        child = types.SimpleNamespace(pid=321)
        directory = pathlib.Path("/synthetic/connected")
        with patch.object(boundary, "private_file") as private, patch.object(boundary, "read_line", return_value=b"otto-live-boundary\n"), patch.object(processes, "start", return_value=child) as start, patch.object(processes, "running", return_value=True), patch.object(processes, "python") as python:
            self.assertEqual(boundary.check_connected_private(processes, directory), 5)
        private.assert_called_once_with(directory / "private", 1002, b"otto-live-boundary")
        self.assertEqual(start.call_args.args[0], 1002)
        calls = python.call_args_list
        self.assertEqual([call.args[0] for call in calls], [1002, 1000, 1000, 1000, 1000, 1000, 1002])
        self.assertEqual(calls[0], calls[-1])
        self.assertIn("/home/otto-connected", calls[1].args[1])
        self.assertIn("/synthetic/connected/private", calls[2].args[1])
        self.assertIn("os.kill(321,0)", calls[3].args[1])
        self.assertIn("/proc/321/environ", calls[4].args[1])
        self.assertIn("/proc/321/cwd", calls[5].args[1])

    def test_connected_process_cannot_die_and_be_reported_as_workspace_denied(self):
        processes = boundary.Processes()
        with patch.object(boundary, "private_file"), patch.object(boundary, "read_line", return_value=b"otto-live-boundary\n"), patch.object(processes, "start", return_value=types.SimpleNamespace(pid=321)), patch.object(processes, "running", side_effect=[True, False]), patch.object(processes, "python"), self.assertRaisesRegex(boundary.BoundaryFailure, "^connected-process$"):
            boundary.check_connected_private(processes, pathlib.Path("/synthetic/connected"))

    def test_connected_cli_accepts_only_the_sealed_install_with_a_clean_environment(self):
        sealed = {"OTTO_BOUNDARY_TOKEN": "synthetic-live-boundary", "HOME": "/tmp/otto-cli-x", "XDG_CONFIG_HOME": "/tmp/otto-cli-x/.config", "LANG": "C.UTF-8"}
        for label, printed in [(None, None), ("connected-cli-planted", "otto-planted-binary\n"), ("connected-cli", "NPM_CONFIG_PREFIX=/workspace\n"), ("connected-cli", "PATH=/home/node/.local/bin:/usr/bin:/bin\n")]:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as root:
                workspace, connected = pathlib.Path(root, "workspace"), pathlib.Path(root, "connected")
                workspace.mkdir()
                connected.mkdir()
                calls = []

                def run(uid, args, timeout=5, extra=None, data=None):
                    calls.append((uid, args, extra, json.loads(data)))
                    request = calls[-1][3]
                    prefix = connected / ("otto-cli-" + request["cli"]["id"])
                    values = {**sealed, "PATH": f"{prefix}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
                    text = "".join(f"{key}={value}\n" for key, value in values.items()) + (printed or "")
                    frames = [{"type": "stdout", "data": base64.b64encode(text.encode()).decode()}, {"type": "exit", "code": 0, "reason": None}]
                    return 0, "".join(json.dumps(frame) + "\n" for frame in frames).encode(), b""

                processes = boundary.Processes()
                with patch.object(processes, "python"), patch.object(processes, "run", side_effect=run), patch.object(boundary.os, "chown"):
                    if label:
                        with self.assertRaisesRegex(boundary.BoundaryFailure, "^" + label + "$"):
                            boundary.check_connected_cli(processes, workspace, connected)
                    else:
                        self.assertTrue(boundary.check_connected_cli(processes, workspace, connected))
                uid, args, extra, request = calls[0]
                self.assertEqual(uid, 1002)
                self.assertEqual(args, ["/bin/sh", "-c", f"cd {connected} && exec /usr/bin/python3 -I -u /opt/otto/workspace-command.py"])
                self.assertTrue(extra["PATH"].startswith(str(workspace / "bin") + ":"))
                self.assertEqual(request["environment"], {"OTTO_BOUNDARY_TOKEN": "synthetic-live-boundary"})
                self.assertTrue((connected / ("otto-cli-" + request["cli"]["id"]) / ".installed").exists())

    def test_cleanup_kills_an_adopted_child_outside_the_original_group(self):
        processes = boundary.Processes()
        child = types.SimpleNamespace(pid=11, returncode=None, stdout=None, stderr=None)
        processes.children.append(child)
        streams = [io.BytesIO(b"11 12"), io.BytesIO(b"")]
        statuses = [(11, 0), (0, 0), (12, 0), (0, 0)]
        with patch.object(boundary.pathlib.Path, "open", side_effect=streams), patch.object(boundary.os, "waitid", side_effect=lambda _kind, pid, _flags: None if pid == 12 else object(), create=True), patch.object(boundary.os, "waitpid", side_effect=statuses), patch.object(boundary.os, "killpg") as group_kill, patch.object(boundary.os, "kill") as process_kill, patch.object(boundary.time, "sleep"):
            self.assertTrue(processes.cleanup())
        self.assertEqual(group_kill.call_args_list, [unittest.mock.call(11, signal.SIGTERM), unittest.mock.call(11, signal.SIGKILL)])
        process_kill.assert_called_once_with(12, signal.SIGKILL)
        self.assertEqual(processes.children, [])

    def test_x11_denial_requires_browser_access_before_and_after(self):
        processes = boundary.Processes()
        display = object()
        environment = {"DISPLAY": ":107", "XAUTHORITY": "/synthetic/Xauthority"}
        with patch.object(processes, "running", return_value=True) as running, patch.object(processes, "run", side_effect=[(0, b"1280 800\n", b""), (1, b"", b"denied"), (0, b"1280 800\n", b"")]) as run:
            boundary.check_x11(processes, environment, display, "workspace", 1000)
        self.assertEqual([call.args[0] for call in run.call_args_list], [1001, 1000, 1001])
        self.assertEqual(running.call_args_list, [unittest.mock.call(display)] * 4)
        for call in run.call_args_list:
            self.assertEqual(call.args[1:], (["/usr/bin/xdotool", "getdisplaygeometry"], 3, environment))

    def test_x11_denial_does_not_pass_after_display_dies_or_browser_loses_access(self):
        for states, results in [
            ([True, True, False], [(0, b"1280 800\n", b""), (1, b"", b"unavailable")]),
            ([True] * 4, [(0, b"1280 800\n", b""), (1, b"", b"denied"), (1, b"", b"unavailable")]),
            ([True, True, True, False], [(0, b"1280 800\n", b""), (1, b"", b"denied"), (0, b"1280 800\n", b"")]),
        ]:
            processes = boundary.Processes()
            with self.subTest(states=states), patch.object(processes, "running", side_effect=states), patch.object(processes, "run", side_effect=results), self.assertRaisesRegex(boundary.BoundaryFailure, "browser-readiness"):
                boundary.check_x11(processes, {}, object(), "connected", 1002)

    def test_cleanup_requires_both_owned_display_paths_absent_after_process_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [pathlib.Path(directory) / ".X107-lock", pathlib.Path(directory) / "X107"]
            processes = boundary.Processes()
            processes.display_paths.extend(paths)
            with patch.object(boundary.pathlib.Path, "open", side_effect=lambda *_args: io.BytesIO(b"")), patch.object(boundary.os, "waitpid", side_effect=ChildProcessError):
                self.assertTrue(processes.cleanup())
                for path in paths:
                    path.touch()
                    with self.subTest(path=path.name):
                        self.assertFalse(processes.cleanup())
                        self.assertTrue(path.exists())
                        self.assertEqual(processes.children, [])
                    path.unlink()
                self.assertTrue(processes.cleanup())

    def test_failure_output_cannot_include_exception_content(self):
        for error, check in [(RuntimeError("synthetic-private-key"), "probe-error"), (boundary.BoundaryFailure("synthetic-private-key"), "probe-error"), (boundary.BoundaryFailure("connected-network"), "connected-network")]:
            output = io.StringIO()
            with patch.object(boundary, "probe", side_effect=error), patch.object(boundary.Processes, "cleanup", return_value=True), patch.object(boundary.signal, "signal"), patch.object(boundary.signal, "alarm"), contextlib.redirect_stdout(output):
                self.assertEqual(boundary.main(), 1)
            self.assertEqual(json.loads(output.getvalue()), {"passed": False, "version": 2, "check": check, "cleanupComplete": True})

    def test_cleanup_failure_prevents_a_success_receipt(self):
        output = io.StringIO()
        with patch.object(boundary, "probe", return_value={"passed": True}), patch.object(boundary.Processes, "cleanup", return_value=False), patch.object(boundary.signal, "signal"), patch.object(boundary.signal, "alarm"), contextlib.redirect_stdout(output):
            self.assertEqual(boundary.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"passed": False, "version": 2, "check": "cleanup", "cleanupComplete": False})


if __name__ == "__main__":
    unittest.main()
