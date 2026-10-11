"""Opt-in Linux/Azure Files probe. Use a fresh UUID; never target runtime files."""

from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from uuid import UUID


def main():
    phase, nonce = sys.argv[1:]
    if phase not in ("write", "read", "cleanup") or str(UUID(nonce)) != nonce:
        raise ValueError("Use write, read, or cleanup followed by a canonical UUID.")
    if os.getuid() == 0:
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)
    if os.getuid() != 10001:
        raise RuntimeError("Probe must run as the host execution uid 10001.")
    os.umask(0o077)
    root = Path("/data/github-native")
    directory = root / f"storage-probe-{nonce}"
    info = root.stat()
    if (info.st_uid, info.st_gid, info.st_mode & 0o777) != (10001, 10001, 0o700):
        raise RuntimeError("The mounted execution directory must be owned by 10001:10001 with mode 0700.")
    try:
        Path("/proc/1/environ").read_bytes()
    except PermissionError:
        pass
    else:
        raise RuntimeError("The execution uid can read the supervisor environment.")
    if phase == "cleanup":
        if directory.is_symlink() or directory.resolve().parent != root.resolve():
            raise RuntimeError("Unsafe probe cleanup path.")
        if (directory / "marker").read_text() != nonce:
            raise RuntimeError("The probe marker does not match; refusing cleanup.")
        shutil.rmtree(directory)
        print(json.dumps({"phase": phase, "result": "passed", "probeId": nonce}))
        return
    if phase == "write":
        directory.mkdir(mode=0o700)
        temporary = directory / "marker.tmp"
        with temporary.open("x") as stream:
            stream.write(nonce)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(directory / "marker")
        lock = directory / "probe.lock"
        contender_command = [
            sys.executable, "-c",
            "import errno,fcntl,sys\n"
            "with open(sys.argv[1],'r+') as f:\n"
            " try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n"
            " except OSError as e:\n"
            "  if e.errno in (errno.EACCES,errno.EAGAIN): sys.exit(17)\n"
            "  raise\n",
            str(lock),
        ]
        with lock.open("w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            contender = subprocess.run(contender_command, check=False, timeout=10)
            if contender.returncode != 17:
                raise RuntimeError("The mount did not exclude a competing file lock.")
        subprocess.run(contender_command, check=True, timeout=10)
        with closing(sqlite3.connect(directory / "probe.db", timeout=5)) as db:
            if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                raise RuntimeError("WAL mode was not enabled.")
            db.execute("CREATE TABLE probe (value TEXT NOT NULL)")
            db.execute("INSERT INTO probe VALUES (?)", (nonce,))
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            contender = subprocess.run([
                sys.executable, "-c",
                "import sqlite3,sys\n"
                "db=sqlite3.connect(sys.argv[1],timeout=0.2)\n"
                "try: db.execute('BEGIN IMMEDIATE')\n"
                "except sqlite3.OperationalError as e:\n"
                " if 'locked' in str(e): sys.exit(0)\n"
                " raise\n"
                "sys.exit(1)\n",
                str(directory / "probe.db"),
            ], check=False, timeout=10)
            if contender.returncode != 0:
                raise RuntimeError("SQLite did not exclude a competing writer.")
            db.rollback()
        # Leave an uncommitted write behind in a process that exits without cleanup.
        subprocess.run([
            sys.executable, "-c",
            "import os,sqlite3,sys;db=sqlite3.connect(sys.argv[1]);"
            "db.execute(\"INSERT INTO probe VALUES ('uncommitted')\");os._exit(0)",
            str(directory / "probe.db"),
        ], check=True, timeout=10)
    if (directory / "marker").read_text() != nonce:
        raise RuntimeError("Atomic marker did not survive.")
    with closing(sqlite3.connect(f"file:{directory / 'probe.db'}?mode=rw", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity check failed.")
        if db.execute("SELECT value FROM probe").fetchall() != [(nonce,)]:
            raise RuntimeError("Committed state was lost or an uncommitted write survived.")
    for path in (directory / "marker", directory / "probe.db"):
        if path.stat().st_mode & 0o077:
            raise RuntimeError("Probe files are accessible outside the execution uid.")
    print(json.dumps({"phase": phase, "result": "passed", "probeId": nonce, "uid": os.getuid()}))


if __name__ == "__main__":
    main()
