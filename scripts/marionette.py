#!/usr/bin/env python3
"""Minimal Marionette client used by install.sh.

  marionette.py <port> run <script.js> [args-json]
  marionette.py <port> quit
"""

import json
import socket
import sys


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port))
        self.msg_id = 0
        self._recv()
        self.cmd("WebDriver:NewSession", {"capabilities": {}})
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def _recv(self):
        buf = b""
        while b":" not in buf:
            buf += self.sock.recv(1)
        size, rest = buf.split(b":", 1)
        size = int(size)
        while len(rest) < size:
            rest += self.sock.recv(size - len(rest))
        return json.loads(rest)

    def cmd(self, name, params=None):
        self.msg_id += 1
        msg = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(str(len(msg)).encode() + b":" + msg)
        reply = self._recv()
        if reply[2]:
            raise SystemExit(f"Marionette error: {reply[2].get('message', reply[2])}")
        return reply[3]


def main():
    port, action = int(sys.argv[1]), sys.argv[2]
    m = Marionette(port)
    if action == "quit":
        m.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
    elif action == "run":
        script = open(sys.argv[3]).read()
        args = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
        result = m.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args, "scriptTimeout": 120000})["value"]
        print(json.dumps(result, indent=1))
        if isinstance(result, dict) and result.get("error"):
            sys.exit(1)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
