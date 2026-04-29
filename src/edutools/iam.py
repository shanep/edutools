from __future__ import annotations

import json
import os
import secrets
import string
import sys
from typing import Callable, Optional

import boto3
from botocore.exceptions import ClientError

from edutools.canvas import CanvasLMS


def _default_progress(current: int, total: int, message: str) -> None:
    """Default progress callback that prints to stderr."""
    print(f"[{current}/{total}] {message}", file=sys.stderr)

EC2_POLICY_NAME = "EC2OnlyAccess"

# EC2-only policy for student users (restricted to us-west-2)
EC2_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowDescribeActions",
            "Effect": "Allow",
            "Action": [
                "ec2:DescribeInstances",
                "ec2:DescribeImages",
                "ec2:DescribeKeyPairs",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeSubnets",
                "ec2:DescribeVpcs",
                "ec2:DescribeAvailabilityZones",
            ],
            "Resource": "*",
            "Condition": {
                "StringEquals": {
                    "aws:RequestedRegion": "us-west-2"
                }
            }
        },
        {
            "Sid": "AllowEC2ActionsInUsWest2",
            "Effect": "Allow",
            "Action": [
                "ec2:RunInstances",
                "ec2:StartInstances",
                "ec2:StopInstances",
                "ec2:TerminateInstances",
                "ec2:CreateKeyPair",
                "ec2:DeleteKeyPair",
                "ec2:CreateSecurityGroup",
                "ec2:DeleteSecurityGroup",
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:AuthorizeSecurityGroupEgress",
                "ec2:CreateTags",
            ],
            "Resource": "*",
            "Condition": {
                "StringEquals": {
                    "aws:RequestedRegion": "us-west-2"
                }
            }
        }
    ],
}


class IAMProvisioner:
    """Provisions AWS IAM users with restricted permissions."""

    def __init__(self, region_name: Optional[str] = None):
        region = region_name or os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-west-2"
        session = boto3.session.Session(region_name=region)
        self.client = session.client("iam")
        self._account_id: Optional[str] = None
        self._sign_in_url: Optional[str] = None
        self._policy_arn_cached: Optional[str] = None

    def _policy_arn(self) -> str:
        """Get the ARN for the EC2 managed policy."""
        if self._policy_arn_cached is None:
            self._policy_arn_cached = f"arn:aws:iam::{self.get_account_id()}:policy/{EC2_POLICY_NAME}"
        return self._policy_arn_cached

    def ensure_ec2_policy(self) -> str:
        """Ensure the EC2 managed policy exists with the current policy document.

        Creates the policy if it doesn't exist, or updates it if it does.

        Returns:
            The policy ARN.
        """
        arn = self._policy_arn()
        policy_doc = json.dumps(EC2_POLICY)

        try:
            self.client.get_policy(PolicyArn=arn)

            # Policy exists — create a new version as the default.
            # AWS enforces a 5-version limit; prune the oldest non-default
            # version if we're at capacity.
            versions_resp = self.client.list_policy_versions(PolicyArn=arn)
            versions = versions_resp["Versions"]
            non_default = [v for v in versions if not v["IsDefaultVersion"]]
            if len(versions) >= 5:
                oldest = min(non_default, key=lambda v: v["CreateDate"])
                self.client.delete_policy_version(
                    PolicyArn=arn, VersionId=oldest["VersionId"]
                )

            self.client.create_policy_version(
                PolicyArn=arn,
                PolicyDocument=policy_doc,
                SetAsDefault=True,
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchEntity":
                self.client.create_policy(
                    PolicyName=EC2_POLICY_NAME,
                    PolicyDocument=policy_doc,
                    Description="EC2-only access restricted to us-west-2",
                )
            else:
                raise

        return arn

    def get_account_id(self) -> str:
        """Get the AWS account ID."""
        if self._account_id is None:
            sts = boto3.client("sts")
            self._account_id = sts.get_caller_identity()["Account"]
        return self._account_id

    def get_sign_in_url(self) -> str:
        """Get the AWS console sign-in URL for IAM users.

        Checks for account alias first, falls back to account ID.

        Returns:
            The sign-in URL (e.g., https://alias.signin.aws.amazon.com/console
            or https://123456789012.signin.aws.amazon.com/console)
        """
        if self._sign_in_url is None:
            try:
                # Try to get account alias
                response = self.client.list_account_aliases()
                aliases = response.get("AccountAliases", [])
                if aliases:
                    self._sign_in_url = f"https://{aliases[0]}.signin.aws.amazon.com/console"
                else:
                    # Fall back to account ID
                    account_id = self.get_account_id()
                    self._sign_in_url = f"https://{account_id}.signin.aws.amazon.com/console"
            except ClientError:
                # Fall back to account ID
                account_id = self.get_account_id()
                self._sign_in_url = f"https://{account_id}.signin.aws.amazon.com/console"
        return self._sign_in_url

    def generate_password(self, length: int = 16) -> str:
        """Generate a secure random password meeting AWS requirements.

        AWS requires: uppercase, lowercase, numbers, and special characters.
        Uses only the most universally compatible special characters.
        """
        if length < 8:
            length = 8

        # Use only the safest special characters for AWS compatibility
        # These work with virtually all AWS password policies
        safe_special = "!@#$_-"

        # Ensure at least one of each required character type
        password_chars = [
            secrets.choice(string.ascii_uppercase),
            secrets.choice(string.ascii_lowercase),
            secrets.choice(string.digits),
            secrets.choice(safe_special),
        ]

        # Fill remaining length with random characters from all types
        all_chars = string.ascii_letters + string.digits + safe_special
        password_chars.extend(secrets.choice(all_chars) for _ in range(length - 4))

        # Shuffle to avoid predictable pattern
        password_list = list(password_chars)
        secrets.SystemRandom().shuffle(password_list)

        return "".join(password_list)

    def create_user(self, username: str) -> dict:
        """Create an IAM user with console access.

        Args:
            username: The IAM username to create

        Returns:
            Dict with keys: username, password, status, error (if any)
        """
        result = {"username": username, "password": None, "status": "error", "error": None}

        try:
            # Create the IAM user
            self.client.create_user(UserName=username)

            # Generate and set login password
            password = self.generate_password()
            self.client.create_login_profile(
                UserName=username,
                Password=password,
                PasswordResetRequired=True,
            )

            result["password"] = password
            result["status"] = "created"

        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code == "EntityAlreadyExists":
                result["status"] = "skipped"
                result["error"] = "already exists"
            else:
                result["error"] = e.response.get("Error", {}).get("Message", str(e))

        return result

    def attach_ec2_policy(self, username: str) -> bool:
        """Attach the EC2 managed policy to a user.

        Also removes the legacy inline policy if present.

        Args:
            username: The IAM username to attach the policy to

        Returns:
            True if successful, False otherwise
        """
        try:
            arn = self.ensure_ec2_policy()
            self.client.attach_user_policy(
                UserName=username,
                PolicyArn=arn,
            )
            # Remove legacy inline policy if present
            try:
                self.client.delete_user_policy(
                    UserName=username, PolicyName=EC2_POLICY_NAME
                )
            except ClientError:
                pass
            return True
        except ClientError:
            return False

    def reset_password(self, username: str) -> dict:
        """Reset the password for an existing IAM user.

        Args:
            username: The IAM username

        Returns:
            Dict with keys: username, password, status, error (if any)
        """
        result = {"username": username, "password": None, "status": "error", "error": None}

        try:
            password = self.generate_password()

            # Try to update existing login profile, or create if it doesn't exist
            try:
                self.client.update_login_profile(
                    UserName=username,
                    Password=password,
                    PasswordResetRequired=True,
                )
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") == "NoSuchEntity":
                    # Login profile doesn't exist, create it
                    self.client.create_login_profile(
                        UserName=username,
                        Password=password,
                        PasswordResetRequired=True,
                    )
                else:
                    raise

            result["password"] = password
            result["status"] = "reset"

        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code == "NoSuchEntity":
                result["status"] = "skipped"
                result["error"] = "user not found"
            else:
                result["error"] = e.response.get("Error", {}).get("Message", str(e))

        return result

    def delete_user(self, username: str) -> dict:
        """Delete an IAM user and all associated resources.

        This removes the login profile, inline policies, and the user itself.

        Args:
            username: The IAM username to delete

        Returns:
            Dict with keys: username, status, error (if any)
        """
        result = {"username": username, "status": "error", "error": None}

        try:
            # Delete login profile (console access)
            try:
                self.client.delete_login_profile(UserName=username)
            except ClientError as e:
                # Ignore if login profile doesn't exist
                if e.response.get("Error", {}).get("Code") != "NoSuchEntity":
                    raise

            # Delete inline policies
            try:
                policies = self.client.list_user_policies(UserName=username)
                for policy_name in policies.get("PolicyNames", []):
                    self.client.delete_user_policy(UserName=username, PolicyName=policy_name)
            except ClientError:
                pass  # Continue even if policy deletion fails

            # Delete attached managed policies
            try:
                attached = self.client.list_attached_user_policies(UserName=username)
                for policy in attached.get("AttachedPolicies", []):
                    self.client.detach_user_policy(
                        UserName=username, PolicyArn=policy["PolicyArn"]
                    )
            except ClientError:
                pass  # Continue even if detach fails

            # Delete access keys
            try:
                keys = self.client.list_access_keys(UserName=username)
                for key_meta in keys.get("AccessKeyMetadata", []):
                    self.client.delete_access_key(
                        UserName=username,
                        AccessKeyId=key_meta["AccessKeyId"],
                    )
            except ClientError:
                pass  # Continue even if access key deletion fails

            # Delete the user
            self.client.delete_user(UserName=username)
            result["status"] = "deleted"

        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code == "NoSuchEntity":
                result["status"] = "skipped"
                result["error"] = "user not found"
            else:
                result["error"] = e.response.get("Error", {}).get("Message", str(e))

        return result


def provision_students(
    course_id: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict]:
    """Provision IAM users for all students in a Canvas course.

    Args:
        course_id: The Canvas course ID
        progress_callback: Optional callback for progress updates (current, total, message)

    Returns:
        List of dicts with: email, username, password, status
    """
    canvas = CanvasLMS()
    iam = IAMProvisioner()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)
    results = []

    if progress_callback:
        progress_callback(0, total, f"Found {total} students. Starting provisioning...")

    for i, student in enumerate(students, 1):
        email = student.get("email", "")
        if not email:
            if progress_callback:
                progress_callback(i, total, f"Skipping user_{student.get('id', 'unknown')} (no email)")
            results.append({
                "email": f"user_{student.get('id', 'unknown')}",
                "username": None,
                "password": None,
                "status": "skipped",
                "error": "no email",
            })
            continue

        # Extract username from email prefix
        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Creating IAM user: {username}")

        # Create the IAM user
        user_result = iam.create_user(username)

        # Attach EC2 policy if user was created
        if user_result["status"] == "created":
            iam.attach_ec2_policy(username)

        results.append({
            "email": email,
            "username": username,
            "password": user_result["password"],
            "status": user_result["status"],
        })

    if progress_callback:
        progress_callback(total, total, "Provisioning complete!")

    return results


def reset_student_passwords(
    course_id: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict]:
    """Reset passwords for all student IAM users in a Canvas course.

    Args:
        course_id: The Canvas course ID
        progress_callback: Optional callback for progress updates (current, total, message)

    Returns:
        List of dicts with: email, username, password, status
    """
    canvas = CanvasLMS()
    iam = IAMProvisioner()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)
    results = []

    if progress_callback:
        progress_callback(0, total, f"Found {total} students. Starting password reset...")

    for i, student in enumerate(students, 1):
        email = student.get("email", "")
        if not email:
            if progress_callback:
                progress_callback(i, total, f"Skipping user_{student.get('id', 'unknown')} (no email)")
            results.append({
                "email": f"user_{student.get('id', 'unknown')}",
                "username": None,
                "password": None,
                "status": "skipped",
                "error": "no email",
            })
            continue

        # Extract username from email prefix
        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Resetting password: {username}")

        # Reset the password
        reset_result = iam.reset_password(username)

        results.append({
            "email": email,
            "username": username,
            "password": reset_result["password"],
            "status": reset_result["status"],
        })

    if progress_callback:
        progress_callback(total, total, "Password reset complete!")

    return results


def update_student_policies(
    course_id: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict]:
    """Update the EC2 policy for all student IAM users in a Canvas course.

    Args:
        course_id: The Canvas course ID
        progress_callback: Optional callback for progress updates (current, total, message)

    Returns:
        List of dicts with: email, username, status
    """
    canvas = CanvasLMS()
    iam = IAMProvisioner()

    if progress_callback:
        progress_callback(0, 0, "Updating managed policy document...")

    # Update the managed policy once — this takes effect for all users
    # who already have it attached.
    iam.ensure_ec2_policy()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)
    results = []

    if progress_callback:
        progress_callback(0, total, f"Found {total} students. Ensuring policy attachment...")

    for i, student in enumerate(students, 1):
        email = student.get("email", "")
        if not email:
            if progress_callback:
                progress_callback(i, total, f"Skipping user_{student.get('id', 'unknown')} (no email)")
            results.append({
                "email": f"user_{student.get('id', 'unknown')}",
                "username": None,
                "status": "skipped",
                "error": "no email",
            })
            continue

        # Extract username from email prefix
        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Attaching policy: {username}")

        # Ensure managed policy is attached (also migrates from inline)
        success = iam.attach_ec2_policy(username)

        results.append({
            "email": email,
            "username": username,
            "status": "updated" if success else "error",
        })

    if progress_callback:
        progress_callback(total, total, "Policy update complete!")

    return results


def provision_and_email_students(
    course_id: str,
    sender_name: str = "Course Instructor",
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict]:
    """Provision IAM users and email credentials to all students.

    Args:
        course_id: The Canvas course ID
        sender_name: Name to use in the email signature
        progress_callback: Optional callback for progress updates

    Returns:
        List of dicts with: email, username, password, status, email_sent
    """
    from edutools.google import send_email

    canvas = CanvasLMS()
    iam = IAMProvisioner()

    if progress_callback:
        progress_callback(0, 0, "Fetching AWS account info...")

    sign_in_url = iam.get_sign_in_url()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)
    results = []

    if progress_callback:
        progress_callback(0, total, f"Found {total} students. Starting provisioning...")

    for i, student in enumerate(students, 1):
        email = student.get("email", "")
        if not email:
            if progress_callback:
                progress_callback(i, total, f"Skipping user_{student.get('id', 'unknown')} (no email)")
            results.append({
                "email": f"user_{student.get('id', 'unknown')}",
                "username": None,
                "password": None,
                "status": "skipped",
                "email_sent": False,
                "error": "no email",
            })
            continue

        # Extract username from email prefix
        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Creating IAM user: {username}")

        # Create the IAM user
        user_result = iam.create_user(username)

        # Attach EC2 policy if user was created
        email_sent = False
        if user_result["status"] == "created":
            iam.attach_ec2_policy(username)

            # Send email with credentials
            if progress_callback:
                progress_callback(i, total, f"Sending email to: {email}")

            subject = "Your AWS Account Credentials"
            body_text = f"""Hello,

Your AWS IAM account has been created. Here are your login credentials:

Sign-in URL: {sign_in_url}
Username: {username}
Temporary Password: {user_result['password']}

IMPORTANT: You will be required to change your password on first login.

Your account has permissions to use EC2 (virtual machines) in the us-west-2 region only.

Best regards,
{sender_name}
"""
            body_html = f"""
<html>
<body>
<p>Hello,</p>

<p>Your AWS IAM account has been created. Here are your login credentials:</p>

<table style="border-collapse: collapse; margin: 20px 0;">
  <tr>
    <td style="padding: 8px; border: 1px solid #ddd; background-color: #f5f5f5;"><strong>Sign-in URL</strong></td>
    <td style="padding: 8px; border: 1px solid #ddd;"><a href="{sign_in_url}">{sign_in_url}</a></td>
  </tr>
  <tr>
    <td style="padding: 8px; border: 1px solid #ddd; background-color: #f5f5f5;"><strong>Username</strong></td>
    <td style="padding: 8px; border: 1px solid #ddd;"><code>{username}</code></td>
  </tr>
  <tr>
    <td style="padding: 8px; border: 1px solid #ddd; background-color: #f5f5f5;"><strong>Temporary Password</strong></td>
    <td style="padding: 8px; border: 1px solid #ddd;"><code>{user_result['password']}</code></td>
  </tr>
</table>

<p><strong>IMPORTANT:</strong> You will be required to change your password on first login.</p>

<p>Your account has permissions to use EC2 (virtual machines) in the <strong>us-west-2</strong> region only.</p>

<p>Best regards,<br>{sender_name}</p>
</body>
</html>
"""
            email_result = send_email(
                to=email,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
            )
            email_sent = email_result.get("success", False)

        results.append({
            "email": email,
            "username": username,
            "password": user_result["password"],
            "status": user_result["status"],
            "email_sent": email_sent,
        })

    if progress_callback:
        progress_callback(total, total, "Provisioning and emailing complete!")

    return results


def deprovision_students(
    course_id: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = _default_progress,
) -> list[dict]:
    """Remove IAM users for all students in a Canvas course.

    Args:
        course_id: The Canvas course ID
        progress_callback: Optional callback for progress updates (current, total, message)

    Returns:
        List of dicts with: email, username, status
    """
    canvas = CanvasLMS()
    iam = IAMProvisioner()

    if progress_callback:
        progress_callback(0, 0, "Fetching students from Canvas...")

    students = canvas.get_students(course_id)
    total = len(students)
    results = []

    if progress_callback:
        progress_callback(0, total, f"Found {total} students. Starting deprovisioning...")

    for i, student in enumerate(students, 1):
        email = student.get("email", "")
        if not email:
            if progress_callback:
                progress_callback(i, total, f"Skipping user_{student.get('id', 'unknown')} (no email)")
            results.append({
                "email": f"user_{student.get('id', 'unknown')}",
                "username": None,
                "status": "skipped",
                "error": "no email",
            })
            continue

        # Extract username from email prefix
        username = email.split("@")[0]

        if progress_callback:
            progress_callback(i, total, f"Deleting IAM user: {username}")

        # Delete the IAM user
        delete_result = iam.delete_user(username)

        results.append({
            "email": email,
            "username": username,
            "status": delete_result["status"],
        })

    if progress_callback:
        progress_callback(total, total, "Deprovisioning complete!")

    return results
