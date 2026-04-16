from __future__ import annotations

import io
import json
import os
import sys
import time
from typing import Callable, Optional

import boto3
import paramiko
from botocore.exceptions import ClientError
from paramiko.ssh_exception import NoValidConnectionsError, SSHException

from edutools.canvas import CanvasLMS

INSTRUCTOR_KEY_FILENAME = "ec2-instructor-access.pem"
"""Name of the instructor PEM file inside the config directory."""

SSH_USER = "ubuntu"
"""Default SSH user on the AMI (set by the Launch Template)."""

_INSTANCE_SETUP_SCRIPT = """\
#!/bin/bash
set -euo pipefail

# Disable fwupd — EC2 firmware is managed by AWS, not the guest OS;
# leaving it enabled on low-memory instances causes OOM kills.
sudo systemctl disable --now \\
    fwupd.service fwupd-refresh.service fwupd-refresh.timer 2>/dev/null || true

# Add 2 GB swap — gives the OOM killer breathing room during
# memory-intensive student workloads.
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi
"""


def _default_progress(current: int, total: int, message: str) -> None:
    """Default progress callback that prints to stderr."""
    print(f"[{current}/{total}] {message}", file=sys.stderr)


class EC2Provisioner:
    """Manages EC2 instances for student lab environments."""

    def __init__(self, region_name: Optional[str] = None) -> None:
        region = (
            region_name
            or os.getenv("AWS_REGION")
            or os.getenv("AWS_DEFAULT_REGION")
            or "us-west-2"
        )
        session = boto3.Session(region_name=region)
        self.ec2 = session.client("ec2")

    @staticmethod
    def generate_ssh_key() -> tuple[str, str]:
        """Generate an RSA-4096 SSH key pair.

        Returns:
            A (private_key_pem, public_key_openssh) tuple.  The private key
            is in PEM format; the public key is in OpenSSH ``authorized_keys``
            format.
        """
        key = paramiko.RSAKey.generate(4096)
        buf = io.StringIO()
        key.write_private_key(buf)
        private_pem = buf.getvalue()
        public_openssh = f"ssh-rsa {key.get_base64()} edutools-generated"
        return private_pem, public_openssh

    def list_launch_templates(self) -> list[dict[str, str]]:
        """List available EC2 Launch Templates.

        Returns a list of dicts with: id, name.
        """
        templates: list[dict[str, str]] = []
        paginator = self.ec2.get_paginator("describe_launch_templates")
        for page in paginator.paginate():
            for lt in page["LaunchTemplates"]:
                lt_id: str = lt["LaunchTemplateId"]
                lt_name: str = lt["LaunchTemplateName"]
                templates.append({"id": lt_id, "name": lt_name})
        return templates

    def launch_instance(
        self,
        *,
        launch_template: str,
        name_tag: str,
        extra_tags: Optional[dict[str, str]] = None,
        user_data: Optional[str] = None,
    ) -> str:
        """Launch a single EC2 instance from a Launch Template.

        The template is expected to define the AMI, instance type, key pair,
        and security group.  Per-instance *user_data* (e.g. student account
        creation) is layered on top.

        Args:
            launch_template: Launch Template name or ID.  If the string starts
                with ``lt-`` it is treated as an ID; otherwise as a name.
            name_tag: Value for the ``Name`` tag on the instance.
            extra_tags: Additional tags to apply.
            user_data: Cloud-init script for first boot.
        """
        tags: list[dict[str, str]] = [{"Key": "Name", "Value": name_tag}]
        if extra_tags:
            tags.extend({"Key": k, "Value": v} for k, v in extra_tags.items())

        if launch_template.startswith("lt-"):
            lt_spec: dict[str, str] = {"LaunchTemplateId": launch_template}
        else:
            lt_spec = {"LaunchTemplateName": launch_template}

        kwargs: dict[str, object] = {
            "LaunchTemplate": lt_spec,
            "MinCount": 1,
            "MaxCount": 1,
            "TagSpecifications": [{"ResourceType": "instance", "Tags": tags}],
        }
        if user_data is not None:
            kwargs["UserData"] = user_data

        # boto3 run_instances accepts **kwargs; the type stubs don't fully
        # model this, so we silence the arg-type diagnostic.
        resp = self.ec2.run_instances(**kwargs)  # pyright: ignore[reportCallIssue]
        instance_id: str = resp["Instances"][0]["InstanceId"]
        return instance_id

    def find_course_instances(self, course_id: str) -> list[dict[str, str]]:
        """Find all running/pending instances tagged with a course ID.

        Returns a list of dicts with: instance_id, student, state, public_ip.
        """
        resp = self.ec2.describe_instances(
            Filters=[
                {"Name": "tag:edutools-course", "Values": [course_id]},
                {"Name": "instance-state-name", "Values": [
                    "pending", "running", "stopping", "stopped",
                ]},
            ],
        )
        instances: list[dict[str, str]] = []
        for reservation in resp["Reservations"]:
            for inst in reservation["Instances"]:
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                instances.append({
                    "instance_id": inst["InstanceId"],
                    "student": tags.get("edutools-student", ""),
                    "state": inst["State"]["Name"],
                    "public_ip": inst.get("PublicIpAddress", ""),
                })
        return instances

    def terminate_instances(
        self, instance_ids: list[str], timeout: int = 300
    ) -> None:
        """Terminate instances and wait for them to reach the terminated state."""
        self.ec2.terminate_instances(InstanceIds=instance_ids)
        waiter = self.ec2.get_waiter("instance_terminated")
        waiter.wait(
            InstanceIds=instance_ids,
            WaiterConfig={"Delay": 15, "MaxAttempts": timeout // 15},
        )

    def reboot_instances(self, instance_ids: list[str]) -> None:
        """Send reboot signal to instances (fire and forget)."""
        self.ec2.reboot_instances(InstanceIds=instance_ids)

    def _get_public_ips(self, instance_ids: list[str]) -> dict[str, str]:
        """Return a mapping of instance_id -> public_ip for the given instances."""
        ip_map: dict[str, str] = {}
        desc = self.ec2.describe_instances(InstanceIds=instance_ids)
        for reservation in desc["Reservations"]:
            for inst in reservation["Instances"]:
                iid: str = inst["InstanceId"]
                pip: str = inst.get("PublicIpAddress", "")
                if pip:
                    ip_map[iid] = pip
        return ip_map

    def wait_for_instances(
        self, instance_ids: list[str], timeout: int = 300
    ) -> dict[str, str]:
        """Wait for instances to reach the running state.

        Returns a mapping of instance_id -> public_ip.
        """
        waiter = self.ec2.get_waiter("instance_running")
        waiter.wait(
            InstanceIds=instance_ids,
            WaiterConfig={"Delay": 10, "MaxAttempts": timeout // 10},
        )

        ip_map: dict[str, str] = {}
        desc = self.ec2.describe_instances(InstanceIds=instance_ids)
        for reservation in desc["Reservations"]:
            for inst in reservation["Instances"]:
                iid: str = inst["InstanceId"]
                pip: str = inst.get("PublicIpAddress", "")
                if pip:
                    ip_map[iid] = pip
        return ip_map

    @staticmethod
    def configure_student_ssh(
        *,
        instructor_key_path: str,
        hostname: str,
        public_key: str,
        ssh_timeout: int = 300,
    ) -> str:
        """SSH into an instance and append a public key to the ubuntu user.

        Connects as ``ubuntu`` using the instructor PEM key and appends
        the student's public key to ``~ubuntu/.ssh/authorized_keys``.

        Args:
            instructor_key_path: Path to the instructor PEM private key.
            hostname: Public IP or DNS of the instance.
            public_key: SSH public key (``authorized_keys`` format) to add.
            ssh_timeout: Seconds to wait for SSH to become available.

        Returns:
            Empty string on success; an error message on failure.
        """
        pkey = paramiko.RSAKey.from_private_key_file(instructor_key_path)
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        connected = False
        deadline = time.monotonic() + ssh_timeout
        last_error = ""

        while time.monotonic() < deadline:
            try:
                ssh.connect(
                    hostname=hostname,
                    username=SSH_USER,
                    pkey=pkey,
                    timeout=10,
                    auth_timeout=10,
                    banner_timeout=10,
                )
                connected = True
                break
            except (NoValidConnectionsError, SSHException, OSError, TimeoutError) as e:
                last_error = str(e)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(10.0, remaining))

        if not connected:
            return f"SSH connect failed: {last_error}"

        try:
            # Run system setup (disable fwupd, add swap) via bash -s over stdin
            # so the script runs as a unit and set -euo pipefail is honoured.
            stdin_setup, stdout_setup, stderr_setup = ssh.exec_command("sudo bash -s")
            stdin_setup.write(_INSTANCE_SETUP_SCRIPT.encode())
            stdin_setup.channel.shutdown_write()
            exit_status = stdout_setup.channel.recv_exit_status()
            if exit_status != 0:
                err_output = stderr_setup.read().decode().strip()
                return f"system setup exited {exit_status}: {err_output}"

            # Add the student's SSH public key
            _, stdout_key, stderr_key = ssh.exec_command(
                f"echo '{public_key}' >> ~/.ssh/authorized_keys"
            )
            exit_status = stdout_key.channel.recv_exit_status()
            if exit_status != 0:
                err_output = stderr_key.read().decode().strip()
                return f"setup exited {exit_status}: {err_output}"
        except SSHException as e:
            return f"SSH command failed: {e}"
        finally:
            ssh.close()

        return ""


def launch_student_vms(
    course_id: str,
    *,
    launch_template: str,
    instructor_key_path: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict[str, str]]:
    """Launch EC2 instances for all students in a Canvas course.

    Instances are created from an AWS Launch Template that defines the AMI,
    instance type, key pair, and security group.  After each instance is
    running, the instructor PEM key is used to SSH in and create a student
    user with a unique SSH key pair.

    Args:
        course_id: Canvas course ID.
        launch_template: AWS Launch Template name or ID.
        instructor_key_path: Path to the instructor PEM private key used to
            SSH into instances as the default ``ubuntu`` user.
        progress_callback: Optional callback for progress updates.

    Returns:
        List of dicts with keys: email, username, instance_id, public_ip,
        private_key, public_key, status.
    """
    canvas = CanvasLMS()
    ec2 = EC2Provisioner()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)

    if progress_callback:
        progress_callback(0, total, f"Found {total} students.")

    results: list[dict[str, str]] = []
    pending: list[dict[str, str]] = []

    for i, student in enumerate(students, 1):
        email = str(student.get("email", ""))
        if not email:
            student_id = str(student.get("id", "unknown"))
            if progress_callback:
                progress_callback(
                    i, total, f"Skipping student {student_id} (no email)"
                )
            results.append({
                "email": f"user_{student_id}",
                "username": "",
                "instance_id": "",
                "public_ip": "",
                "private_key": "",
                "public_key": "",
                "status": "skipped",
            })
            continue

        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Launching instance for {username}...")

        try:
            private_key, public_key = EC2Provisioner.generate_ssh_key()
            instance_id = ec2.launch_instance(
                launch_template=launch_template,
                name_tag=f"{username}-vm",
                extra_tags={
                    "edutools-course": course_id,
                    "edutools-student": username,
                },
            )
            pending.append({
                "email": email,
                "username": username,
                "instance_id": instance_id,
                "private_key": private_key,
                "public_key": public_key,
            })
        except ClientError as e:
            msg = e.response.get("Error", {}).get("Message", str(e))
            results.append({
                "email": email,
                "username": username,
                "instance_id": "",
                "public_ip": "",
                "private_key": "",
                "public_key": "",
                "status": f"error: {msg}",
            })

    if not pending:
        if progress_callback:
            progress_callback(total, total, "No instances to configure.")
        return results

    # Wait for all instances to be running and get public IPs
    if progress_callback:
        progress_callback(0, len(pending), "Waiting for instances to start...")

    instance_ids = [m["instance_id"] for m in pending]
    try:
        ip_map = ec2.wait_for_instances(instance_ids)
    except Exception as e:
        for m in pending:
            results.append({
                "email": m["email"],
                "username": m["username"],
                "instance_id": m["instance_id"],
                "public_ip": "",
                "private_key": "",
                "public_key": "",
                "status": f"error: {e}",
            })
        return results

    # SSH into each instance with instructor key to set up the student user
    for idx, m in enumerate(pending, 1):
        iid = m["instance_id"]
        public_ip = ip_map.get(iid, "")

        if not public_ip:
            results.append({
                "email": m["email"],
                "username": m["username"],
                "instance_id": iid,
                "public_ip": "",
                "private_key": "",
                "public_key": "",
                "status": "error: no public IP",
            })
            continue

        if progress_callback:
            progress_callback(
                idx, len(pending),
                f"Configuring {m['username']} on {public_ip}...",
            )

        err = EC2Provisioner.configure_student_ssh(
            instructor_key_path=instructor_key_path,
            hostname=public_ip,
            public_key=m["public_key"],
        )

        if err:
            results.append({
                "email": m["email"],
                "username": m["username"],
                "instance_id": iid,
                "public_ip": public_ip,
                "private_key": "",
                "public_key": "",
                "status": f"error: {err}",
            })
        else:
            results.append({
                "email": m["email"],
                "username": m["username"],
                "instance_id": iid,
                "public_ip": public_ip,
                "private_key": m["private_key"],
                "public_key": m["public_key"],
                "status": "launched",
            })

    if progress_callback:
        progress_callback(len(pending), len(pending), "All instances configured!")

    return results


def terminate_student_vms(
    course_id: str,
    *,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict[str, str]]:
    """Terminate all EC2 instances tagged with a course ID.

    Finds instances by the ``edutools-course`` tag applied during launch,
    terminates them, and waits for termination to complete.

    Args:
        course_id: Canvas course ID used when the instances were launched.
        progress_callback: Optional callback for progress updates.

    Returns:
        List of dicts with: instance_id, student, status.
    """
    ec2 = EC2Provisioner()

    if progress_callback:
        progress_callback(0, 0, "Finding instances for course...")

    instances = ec2.find_course_instances(course_id)

    if not instances:
        if progress_callback:
            progress_callback(0, 0, "No instances found for this course.")
        return []

    if progress_callback:
        progress_callback(
            0, len(instances), f"Found {len(instances)} instances. Terminating..."
        )

    instance_ids = [i["instance_id"] for i in instances]

    try:
        ec2.terminate_instances(instance_ids)
    except ClientError as e:
        msg = e.response.get("Error", {}).get("Message", str(e))
        return [
            {
                "instance_id": i["instance_id"],
                "student": i["student"],
                "status": f"error: {msg}",
            }
            for i in instances
        ]

    if progress_callback:
        progress_callback(
            len(instances), len(instances), "All instances terminated!"
        )

    return [
        {
            "instance_id": i["instance_id"],
            "student": i["student"],
            "status": "terminated",
        }
        for i in instances
    ]


def check_ec2_launch(
    *,
    launch_template: str,
    instructor_key_path: str,
    username: str = "testuser",
    ssh_timeout: int = 300,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> dict[str, str]:
    """End-to-end check: launch a test VM, add a key via instructor SSH, verify login, terminate.

    Launches a single instance from *launch_template*, SSHes in as
    ``ubuntu`` with the instructor key to add a generated public key,
    then verifies login as ``ubuntu`` with the generated private key.

    Args:
        launch_template: AWS Launch Template name or ID.
        instructor_key_path: Path to the instructor PEM private key.
        username: Name tag for the VM (e.g. ``testuser`` → ``testuser-vm``).
        ssh_timeout: Seconds to wait for SSH to become available.
        progress_callback: Optional callback for progress updates.

    Returns:
        Dict with keys: instance_id, public_ip, username,
        ssh_output, status, private_key.
    """
    ec2 = EC2Provisioner()
    private_pem, public_key = EC2Provisioner.generate_ssh_key()
    instance_id = ""

    result: dict[str, str] = {
        "instance_id": "",
        "public_ip": "",
        "username": SSH_USER,
        "ssh_output": "",
        "status": "error",
        "private_key": private_pem,
    }

    # Step 1: Launch instance
    if progress_callback:
        progress_callback(1, 5, "Launching test instance...")
    instance_id = ec2.launch_instance(
        launch_template=launch_template,
        name_tag=f"{username}-vm",
        extra_tags={"edutools-check": "true"},
    )
    result["instance_id"] = instance_id

    # Step 2: Wait for running
    if progress_callback:
        progress_callback(2, 5, "Waiting for instance to start...")
    ip_map = ec2.wait_for_instances([instance_id])
    public_ip = ip_map.get(instance_id, "")
    if not public_ip:
        result["status"] = "error: no public IP"
        return result
    result["public_ip"] = public_ip

    # Step 3: SSH in with instructor key and add the generated public key
    if progress_callback:
        progress_callback(3, 5, f"Adding test key via instructor SSH ({public_ip})...")

    err = EC2Provisioner.configure_student_ssh(
        instructor_key_path=instructor_key_path,
        hostname=public_ip,
        public_key=public_key,
        ssh_timeout=ssh_timeout,
    )
    if err:
        result["status"] = f"error: setup failed — {err}"
        return result

    # Step 4: Verify login as ubuntu with the generated key
    if progress_callback:
        progress_callback(4, 5, f"Verifying SSH login with generated key...")

    pkey = paramiko.RSAKey.from_private_key(io.StringIO(private_pem))
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connected = False
    deadline = time.monotonic() + 60
    last_error = ""
    while time.monotonic() < deadline:
        try:
            ssh.connect(
                hostname=public_ip,
                username=SSH_USER,
                pkey=pkey,
                timeout=10,
                auth_timeout=10,
                banner_timeout=10,
            )
            connected = True
            break
        except (NoValidConnectionsError, SSHException, OSError, TimeoutError) as e:
            last_error = str(e)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(5.0, remaining))

    if not connected:
        result["status"] = f"error: SSH with generated key failed — {last_error}"
        return result

    # Step 5: Run a command to verify
    if progress_callback:
        progress_callback(5, 5, "Running test command over SSH...")
    try:
        _stdin, stdout, _stderr = ssh.exec_command("echo hello-from-edutools && whoami")
        output = stdout.read().decode().strip()
        ssh.close()
    except SSHException as e:
        result["status"] = f"error: command failed — {e}"
        return result

    result["ssh_output"] = output

    if "hello-from-edutools" in output:
        result["status"] = "passed"
    else:
        result["status"] = f"error: unexpected output — {output!r}"

    return result


def cleanup_check_instances(
    *,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict[str, str]]:
    """Terminate all EC2 instances tagged with ``edutools-check``.

    Finds instances created by :func:`check_ec2_launch` and terminates them.

    Args:
        progress_callback: Optional callback for progress updates.

    Returns:
        List of dicts with: instance_id, state, status.
    """
    ec2 = EC2Provisioner()

    if progress_callback:
        progress_callback(0, 0, "Finding check instances...")

    resp = ec2.ec2.describe_instances(
        Filters=[
            {"Name": "tag:edutools-check", "Values": ["true"]},
            {"Name": "instance-state-name", "Values": [
                "pending", "running", "stopping", "stopped",
            ]},
        ],
    )

    instances: list[dict[str, str]] = []
    for reservation in resp["Reservations"]:
        for inst in reservation["Instances"]:
            instances.append({
                "instance_id": inst["InstanceId"],
                "state": inst["State"]["Name"],
            })

    if not instances:
        if progress_callback:
            progress_callback(0, 0, "No check instances found.")
        return []

    if progress_callback:
        progress_callback(
            0, len(instances),
            f"Found {len(instances)} check instance(s). Terminating...",
        )

    instance_ids = [i["instance_id"] for i in instances]

    try:
        ec2.terminate_instances(instance_ids)
    except ClientError as e:
        msg = e.response.get("Error", {}).get("Message", str(e))
        return [
            {
                "instance_id": i["instance_id"],
                "state": i["state"],
                "status": f"error: {msg}",
            }
            for i in instances
        ]

    if progress_callback:
        progress_callback(
            len(instances), len(instances), "All check instances terminated!"
        )

    return [
        {
            "instance_id": i["instance_id"],
            "state": i["state"],
            "status": "terminated",
        }
        for i in instances
    ]


def check_ssh_access(
    course_id: str,
    *,
    instructor_key_path: str,
    log_file: str = "ssh-failures.log",
    ssh_timeout: int = 30,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict[str, str]]:
    """Check SSH access for all running EC2 instances in a course.

    Iterates through every running instance tagged with *course_id*,
    attempts an SSH connection using the instructor key, and writes
    any failures to *log_file*.

    Args:
        course_id: Canvas course ID used when the instances were launched.
        instructor_key_path: Path to the instructor PEM private key.
        log_file: Path to write unreachable instance details.
        ssh_timeout: Seconds to wait for each SSH connection attempt.
        progress_callback: Optional callback for progress updates.

    Returns:
        List of dicts with: instance_id, student, public_ip, status.
    """
    ec2 = EC2Provisioner()

    if progress_callback:
        progress_callback(0, 0, "Finding running instances...")

    instances = ec2.find_course_instances(course_id)
    running = [i for i in instances if i["state"] == "running" and i["public_ip"]]

    if not running:
        if progress_callback:
            progress_callback(0, 0, "No running instances with public IPs found.")
        return []

    total = len(running)
    if progress_callback:
        progress_callback(0, total, f"Checking SSH on {total} instance(s)...")

    pkey = paramiko.RSAKey.from_private_key_file(instructor_key_path)
    results: list[dict[str, str]] = []
    failures: list[dict[str, str]] = []

    for idx, inst in enumerate(running, 1):
        iid = inst["instance_id"]
        ip = inst["public_ip"]
        student = inst["student"]

        if progress_callback:
            progress_callback(idx, total, f"SSH {student or iid} @ {ip}...")

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        status = "ok"

        try:
            ssh.connect(
                hostname=ip,
                username=SSH_USER,
                pkey=pkey,
                timeout=ssh_timeout,
                auth_timeout=ssh_timeout,
                banner_timeout=ssh_timeout,
            )
            ssh.close()
        except (NoValidConnectionsError, SSHException, OSError, TimeoutError) as e:
            status = f"unreachable: {e}"
            failures.append({
                "instance_id": iid,
                "student": student,
                "public_ip": ip,
                "error": str(e),
            })

        results.append({
            "instance_id": iid,
            "student": student,
            "public_ip": ip,
            "status": status,
        })

    # Write failures to log file (JSON for machine-readability)
    if failures:
        log_data = {
            "course_id": course_id,
            "instances": failures,
        }
        with open(log_file, "w") as f:
            json.dump(log_data, f, indent=2)
            f.write("\n")

    if progress_callback:
        ok = sum(1 for r in results if r["status"] == "ok")
        progress_callback(
            total, total,
            f"Done — {ok} reachable, {len(failures)} unreachable.",
        )

    return results


SSH_SCRIPT_FILENAME = "ec2-ssh.sh"

_SSH_SCRIPT_TEMPLATE = """\
#!/bin/bash
# EC2 SSH Connection Script
# Student:  {username}
# Host:     {public_ip}
# Instance: {instance_id}
#
# Usage: bash ec2-ssh.sh

HOST="{public_ip}"
USER="ubuntu"
SSH_DIR="$HOME/.ssh/"
AWS_KEY='aws-{username}.pem'
PRIVATE_KEY='{private_key}'

mkdir -p "$SSH_DIR"
echo "Writing SSH key to $SSH_DIR$AWS_KEY..."
printf '%s\\n' "$PRIVATE_KEY" > "$SSH_DIR$AWS_KEY"
chmod 600 "$SSH_DIR$AWS_KEY"

echo "Here are your connection details:"
echo "Host: $HOST"
echo "Username: $USER"
echo "Public IP: $HOST"
echo "Instance ID: {instance_id}"
echo "SSH Command: ssh -i $SSH_DIR$AWS_KEY $USER@$HOST"
echo "DO NOT COMMIT THIS FILE TO ANY PUBLIC REPOSITORY."
"""


def build_ssh_script(
    *, username: str, public_ip: str, instance_id: str, private_key: str,
) -> str:
    """Build a self-contained bash script that SSHs into a student's VM.

    The script embeds the private key, writes it to a temporary file with
    correct permissions, connects via SSH, and cleans up the temp file on
    exit.  It also removes stale temp files from previous runs on startup.
    """
    return _SSH_SCRIPT_TEMPLATE.format(
        username=username,
        public_ip=public_ip,
        instance_id=instance_id,
        private_key=private_key.rstrip("\n"),
    )


def build_connection_doc(*, username: str, public_ip: str, instance_id: str) -> str:
    """Build text content for a VM connection-details document.

    Returns a plain-text string suitable for inserting into a Google Doc
    that tells the student how to connect to their EC2 instance via SSH.
    """
    return (
        f"VM Access -- {username}\n"
        f"\n"
        f"Connection Details\n"
        f"------------------\n"
        f"Host:        {public_ip}\n"
        f"Username:    ubuntu\n"
        f"Instance ID: {instance_id}\n"
        f"\n"
        f"How to Connect\n"
        f"--------------\n"
        f"\n"
        f"1. Download the '{SSH_SCRIPT_FILENAME}' file from the shared Google Drive folder.\n"
        f"\n"
        f"2. Open a terminal and navigate to the folder where you saved the file.\n"
        f"\n"
        f"3. Make the script executable and run it:\n"
        f"\n"
        f"   chmod +x {SSH_SCRIPT_FILENAME}\n"
        f"   ./{SSH_SCRIPT_FILENAME}\n"
        f"\n"
        f"   Or simply run it with bash:\n"
        f"\n"
        f"   bash {SSH_SCRIPT_FILENAME}\n"
        f"\n"
        f"4. You can now deploy your app to your VM.\n"
        f"\n"
        f"Troubleshooting\n"
        f"---------------\n"
        f"- If the connection times out, the VM may still be starting up. Wait a minute and try again.\n"
        f"- If you have other issues, email your instructor for assistance.\n"
    )


def reboot_failed_instances(
    log_file: str = "ssh-failures.log",
    *,
    instructor_key_path: str,
    ssh_timeout: int = 300,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict[str, str]]:
    """Reboot instances in the SSH failure log and wait for them to come back.

    Reads the JSON log file produced by :func:`check_ssh_access`, sends a
    reboot signal to **all** listed instances at once, then polls SSH on each
    until it becomes reachable again (or ``ssh_timeout`` is exceeded).

    Args:
        log_file: Path to the JSON failure log written by ``check_ssh_access``.
        instructor_key_path: Path to the instructor PEM private key used to
            verify SSH access after reboot.
        ssh_timeout: Seconds to wait for each instance to become reachable
            over SSH after the reboot signal is sent.
        progress_callback: Optional callback for progress updates.

    Returns:
        List of dicts with: instance_id, student, public_ip, status.
        Status is ``"online"`` when SSH succeeds, or ``"unreachable: <err>"``
        when the instance did not respond within *ssh_timeout* seconds.
    """
    with open(log_file) as f:
        log_data = json.load(f)

    entries = log_data.get("instances", [])
    if not entries:
        return []

    ec2 = EC2Provisioner()
    instance_ids = [e["instance_id"] for e in entries]
    total = len(instance_ids)

    # Step 1: Reboot all instances at once before waiting on any of them.
    if progress_callback:
        progress_callback(0, total, f"Sending reboot signal to {total} instance(s)...")

    ec2.reboot_instances(instance_ids)

    # Give instances a moment to begin shutting down before we start polling.
    time.sleep(15)

    # Step 2: Poll SSH on each instance until it comes back or times out.
    pkey = paramiko.RSAKey.from_private_key_file(instructor_key_path)
    results: list[dict[str, str]] = []

    for idx, entry in enumerate(entries, 1):
        iid = entry["instance_id"]
        student = entry.get("student", "")
        public_ip = entry.get("public_ip", "")

        if not public_ip:
            results.append({
                "instance_id": iid,
                "student": student,
                "public_ip": "",
                "status": "unreachable: no public IP",
            })
            continue

        if progress_callback:
            progress_callback(
                idx, total,
                f"Waiting for {student or iid} @ {public_ip} to come back...",
            )

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        deadline = time.monotonic() + ssh_timeout
        last_error = ""
        online = False

        while time.monotonic() < deadline:
            try:
                ssh.connect(
                    hostname=public_ip,
                    username=SSH_USER,
                    pkey=pkey,
                    timeout=10,
                    auth_timeout=10,
                    banner_timeout=10,
                )
                ssh.close()
                online = True
                break
            except (NoValidConnectionsError, SSHException, OSError, TimeoutError) as e:
                last_error = str(e)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(15.0, remaining))

        results.append({
            "instance_id": iid,
            "student": student,
            "public_ip": public_ip,
            "status": "online" if online else f"unreachable: {last_error}",
        })

    if progress_callback:
        online_count = sum(1 for r in results if r["status"] == "online")
        progress_callback(
            total, total,
            f"Done — {online_count}/{total} instance(s) back online.",
        )

    return results
