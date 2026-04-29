import os
import tomllib
import typer
import csv
from typing import Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich import print as rprint

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "edutools")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.toml")

_DEFAULT_CONFIG = """\
# Edutools Configuration
# Fill in the values below for each service you want to use.
# Run 'edutools check' to verify your credentials after editing.

[canvas]
# API access token (required for Canvas commands)
# Generate at: Canvas -> Account -> Settings -> Approved Integrations -> + New Access Token
token = ""
# Canvas instance URL (optional, defaults to https://boisestatecanvas.instructure.com)
# endpoint = "https://boisestatecanvas.instructure.com"

[google]
# Path to Google OAuth client_secret.json (optional)
# Default location: ~/.config/edutools/client_secret.json
#
# Setup steps:
#   1. Create a project at https://console.cloud.google.com
#   2. Enable the Google Docs, Drive, and Gmail APIs
#   3. Create OAuth 2.0 credentials (Desktop application)
#   4. Download the client secrets JSON and save to ~/.config/edutools/client_secret.json
# oauth_path = ""

[aws]
# AWS credentials for IAM user management
# Get these from AWS IAM console -> Security Credentials
access_key_id = ""
secret_access_key = ""
# AWS region (optional, defaults to us-west-2)
# region = "us-west-2"
"""

app = typer.Typer(
    name="edutools",
    help="🎓 Educational Tools CLI - Manage Canvas LMS, AWS IAM, and Google Docs",
    add_completion=False,
    rich_markup_mode="rich",
)

console = Console()

# Sub-apps for organization
canvas_app = typer.Typer(
    help="📚 Canvas LMS — courses, students, assignments, and submissions",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
iam_app = typer.Typer(
    help="☁️  AWS IAM — provision and manage student accounts",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
ec2_app = typer.Typer(
    help="🖥️  AWS EC2 — launch and manage student virtual machines",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
google_app = typer.Typer(
    help="📄 Google — Drive, Docs, and Gmail operations",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
maintenance_app = typer.Typer(
    help="🔧 Maintenance — SSH checks and instance recovery",
    no_args_is_help=True,
    rich_markup_mode="rich",
)

app.add_typer(canvas_app, name="canvas")
app.add_typer(iam_app, name="iam")
app.add_typer(ec2_app, name="ec2")
app.add_typer(google_app, name="google")
ec2_app.add_typer(maintenance_app, name="maintenance")


def _check_config() -> tuple[bool, bool, bool]:
    """Check which services are configured. Returns (canvas, google, aws)."""
    has_canvas = bool(os.getenv("CANVAS_TOKEN"))
    has_google = os.path.exists(os.path.join(CONFIG_DIR, "client_secret.json"))
    has_aws = bool(os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY"))
    if not has_aws:
        has_aws = os.path.exists(os.path.join(os.path.expanduser("~"), ".aws", "credentials"))
    return has_canvas, has_google, has_aws


def _show_setup_status(has_canvas: bool, has_google: bool, has_aws: bool) -> None:
    """Display which services are configured and setup instructions for missing ones."""
    lines: list[str] = []

    lines.append(f"Config file: [cyan]{CONFIG_FILE}[/cyan]\n")

    # --- Canvas ---
    if has_canvas:
        lines.append("[green]✓[/green] [bold magenta]Canvas LMS[/bold magenta] - configured")
    else:
        lines.append("[red]✗[/red] [bold magenta]Canvas LMS[/bold magenta] - not configured")
        lines.append(f"  Edit [cyan]{CONFIG_FILE}[/cyan] [canvas] section:")
        lines.append("  [yellow]token[/yellow]    - API access token (required)")
        lines.append("              Generate at: Canvas -> Account -> Settings")
        lines.append("              -> Approved Integrations -> + New Access Token")
        lines.append("  [yellow]endpoint[/yellow] - Canvas URL (optional)")
        lines.append("              Defaults to https://boisestatecanvas.instructure.com")

    lines.append("")

    # --- Google ---
    if has_google:
        lines.append("[green]✓[/green] [bold magenta]Google Docs / Gmail[/bold magenta] - configured")
    else:
        lines.append("[red]✗[/red] [bold magenta]Google Docs / Gmail[/bold magenta] - not configured")
        lines.append("  1. Create a project at https://console.cloud.google.com")
        lines.append("  2. Enable the Google Docs, Drive, and Gmail APIs")
        lines.append("  3. Create OAuth 2.0 credentials (Desktop application)")
        lines.append("  4. Download the client secrets JSON and save as:")
        lines.append(f"     [cyan]{os.path.join(CONFIG_DIR, 'client_secret.json')}[/cyan]")
        lines.append(f"  Or set [yellow]oauth_path[/yellow] in [cyan]{CONFIG_FILE}[/cyan] [google] section")

    lines.append("")

    # --- AWS ---
    if has_aws:
        lines.append("[green]✓[/green] [bold magenta]AWS IAM[/bold magenta] - configured")
    else:
        lines.append("[red]✗[/red] [bold magenta]AWS IAM[/bold magenta] - not configured")
        lines.append(f"  Edit [cyan]{CONFIG_FILE}[/cyan] [aws] section:")
        lines.append("  [yellow]access_key_id[/yellow]     - Your AWS access key")
        lines.append("  [yellow]secret_access_key[/yellow] - Your AWS secret key")

    lines.append("")
    lines.append("[dim]Run 'edutools check' to verify credentials work.[/dim]")

    console.print(Panel.fit(
        "\n".join(lines),
        title="Setup Status",
        border_style="yellow",
    ))


def _load_config() -> dict[str, dict[str, str]]:
    """Read config.toml and set environment variables for all services.

    Config file values take precedence over existing environment variables.
    """
    if not os.path.exists(CONFIG_FILE):
        return {}

    with open(CONFIG_FILE, "rb") as f:
        config = tomllib.load(f)

    # Canvas
    canvas = config.get("canvas", {})
    if canvas.get("token"):
        os.environ["CANVAS_TOKEN"] = canvas["token"]
    if canvas.get("endpoint"):
        os.environ["CANVAS_ENDPOINT"] = canvas["endpoint"]

    # AWS
    aws = config.get("aws", {})
    if aws.get("access_key_id"):
        os.environ["AWS_ACCESS_KEY_ID"] = aws["access_key_id"]
    if aws.get("secret_access_key"):
        os.environ["AWS_SECRET_ACCESS_KEY"] = aws["secret_access_key"]
    if aws.get("region"):
        os.environ["AWS_DEFAULT_REGION"] = aws["region"]

    # Google
    google = config.get("google", {})
    if google.get("oauth_path"):
        os.environ["GOOGLE_OAUTH_PATH"] = google["oauth_path"]

    return config


def init():
    """Initialize environment and ensure config directory exists."""
    os.makedirs(CONFIG_DIR, exist_ok=True)

    # Create default config file with placeholders on first run
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            f.write(_DEFAULT_CONFIG)

    _load_config()
    has_canvas, has_google, has_aws = _check_config()
    if not has_canvas or not has_google or not has_aws:
        _show_setup_status(has_canvas, has_google, has_aws)


# ============================================================================
# Check Command
# ============================================================================

@app.command("check")
def check_credentials():
    """Test all configured service credentials."""
    init()

    passed = 0
    failed = 0
    skipped = 0
    results: list[str] = []

    def _ok(service: str, detail: str) -> None:
        nonlocal passed
        passed += 1
        results.append(f"  [green]✓[/green] [bold]{service}[/bold] — {detail}")

    def _fail(service: str, detail: str, error: str) -> None:
        nonlocal failed
        failed += 1
        results.append(f"  [red]✗[/red] [bold]{service}[/bold] — {detail}")
        results.append(f"    [red]Error:[/red] {error}")

    def _skip(service: str, detail: str) -> None:
        nonlocal skipped
        skipped += 1
        results.append(f"  [yellow]⊘[/yellow] [bold]{service}[/bold] — {detail}")

    # --- Canvas ---
    canvas_endpoint = os.getenv("CANVAS_ENDPOINT", "https://boisestatecanvas.instructure.com")
    canvas_token = os.getenv("CANVAS_TOKEN")
    if not canvas_token:
        _skip("Canvas LMS", "token not set in config.toml [canvas] section")
    else:
        try:
            from edutools.canvas import CanvasLMS
            with console.status("[bold green]Testing Canvas...", spinner="dots"):
                canvas = CanvasLMS()
                courses = canvas.get_courses()
            _ok("Canvas LMS", f"{canvas_endpoint} ({len(courses)} courses)")
        except (Exception, SystemExit) as e:
            _fail("Canvas LMS", canvas_endpoint, str(e))

    # --- Google Docs / Drive ---
    try:
        from edutools.google import _get_oauth_path
        _get_oauth_path()
        oauth_found = True
    except (Exception, SystemExit):
        oauth_found = False

    if not oauth_found:
        _skip("Google Docs", "client_secret.json not found in ~/.config/edutools/")
        _skip("Gmail", "Requires Google OAuth (see Google Docs above)")
    else:
        try:
            from edutools.google import _get_credentials
            with console.status("[bold green]Testing Google Docs...", spinner="dots"):
                _get_credentials()
            _ok("Google Docs", "OAuth token valid")
        except (Exception, SystemExit) as e:
            _fail("Google Docs", "OAuth authentication failed", str(e))

        try:
            from edutools.google import _get_gmail_credentials
            with console.status("[bold green]Testing Gmail...", spinner="dots"):
                _get_gmail_credentials()
            _ok("Gmail", "OAuth token valid")
        except (Exception, SystemExit) as e:
            _fail("Gmail", "OAuth authentication failed", str(e))

    # --- AWS IAM ---
    try:
        import boto3
        with console.status("[bold green]Testing AWS...", spinner="dots"):
            sts = boto3.client("sts")
            identity = sts.get_caller_identity()
        account_id = identity["Account"]
        arn = identity["Arn"]
        _ok("AWS IAM", f"Account {account_id} ({arn})")
    except ImportError:
        _skip("AWS IAM", "boto3 not installed")
    except (Exception, SystemExit) as e:
        _fail("AWS IAM", "STS GetCallerIdentity failed", str(e))

    # --- Summary ---
    console.print()
    console.print(Panel.fit(
        "\n".join(results) + "\n\n"
        f"[green]✓ Passed: {passed}[/green]  "
        f"[red]✗ Failed: {failed}[/red]  "
        f"[yellow]⊘ Skipped: {skipped}[/yellow]",
        title="Credential Check",
        border_style="green" if failed == 0 else "red",
    ))


# ============================================================================
# Canvas Commands
# ============================================================================

@canvas_app.command("courses")
def list_courses(
    all_courses: bool = typer.Option(False, "--all", "-a", help="Show all courses, including past/completed ones"),
):
    """List courses where you are a teacher."""
    init()
    from edutools.canvas import CanvasLMS

    label = "all" if all_courses else "active"
    with console.status(f"[bold green]Fetching {label} courses from Canvas...", spinner="dots"):
        canvas = CanvasLMS()
        courses = canvas.get_courses(include_all=all_courses)

    if not courses:
        console.print("[yellow]No courses found.[/yellow]")
        return

    title = "📚 All Canvas Courses" if all_courses else "📚 Active Canvas Courses"
    table = Table(title=title, show_header=True, header_style="bold magenta")
    table.add_column("ID", style="cyan", justify="right")
    table.add_column("Course Name", style="green")

    for c in courses:
        table.add_row(str(c["id"]), str(c["name"]))

    console.print(table)
    console.print(f"\n[dim]Total: {len(courses)} courses[/dim]")


@canvas_app.command("assignments")
def list_assignments(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
):
    """List all assignments for a course."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()

    with console.status(f"[bold green]Fetching assignments for course {course_id}...", spinner="dots"):
        canvas = CanvasLMS()
        assignments = canvas.get_assignments(course_id)

    if not assignments:
        console.print("[yellow]No assignments found.[/yellow]")
        return

    table = Table(title=f"📝 Assignments for Course {course_id}", show_header=True, header_style="bold magenta")
    table.add_column("ID", style="cyan", justify="right")
    table.add_column("Assignment Name", style="green")

    for a in assignments:
        table.add_row(str(a["id"]), a["name"])

    console.print(table)
    console.print(f"\n[dim]Total: {len(assignments)} assignments[/dim]")


@canvas_app.command("students")
def list_students(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
):
    """List all students in a course."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()

    with console.status(f"[bold green]Fetching students for course {course_id}...", spinner="dots"):
        canvas = CanvasLMS()
        students = canvas.get_students(course_id)

    if not students:
        console.print("[yellow]No students found.[/yellow]")
        return

    table = Table(title=f"👥 Students in Course {course_id}", show_header=True, header_style="bold magenta")
    table.add_column("ID", style="cyan", justify="right")
    table.add_column("Email", style="green")

    for s in students:
        table.add_row(str(s["id"]), s.get("email", "[dim]No email[/dim]"))

    console.print(table)
    console.print(f"\n[dim]Total: {len(students)} students[/dim]")


@canvas_app.command("submissions")
def list_submissions(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    assignment_id: Optional[str] = typer.Argument(None, help="Assignment ID"),
):
    """List all submissions for an assignment."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()
    if assignment_id is None:
        assignment_id = _select_assignment(course_id)

    with console.status(f"[bold green]Fetching submissions...", spinner="dots"):
        canvas = CanvasLMS()
        submissions = canvas.get_submissions(course_id, assignment_id)

    if not submissions:
        console.print("[yellow]No submissions found.[/yellow]")
        return

    table = Table(title=f"📊 Submissions for Assignment {assignment_id}", show_header=True, header_style="bold magenta")
    table.add_column("User ID", style="cyan", justify="right")
    table.add_column("Grade", style="green")

    for sub in submissions:
        grade = sub.get("grade") or "[dim]Not graded[/dim]"
        table.add_row(str(sub["user_id"]), str(grade))

    console.print(table)
    console.print(f"\n[dim]Total: {len(submissions)} submissions[/dim]")


@canvas_app.command("ungraded")
def list_ungraded(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
):
    """Show all submissions with no grade set (displayed as '-' in Canvas)."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()

    canvas = CanvasLMS()
    with console.status("[bold green]Fetching assignments...", spinner="dots"):
        assignments = canvas.get_assignments(course_id)
    assignment_names = {str(a["id"]): str(a["name"]) for a in assignments}

    with console.status("[bold green]Fetching submissions...", spinner="dots"):
        ungraded = canvas.get_ungraded_submissions(course_id)

    if not ungraded:
        console.print("[green]All submissions have been graded.[/green]")
        return

    table = Table(
        title=f"Ungraded Submissions — Course {course_id}",
        show_header=True,
        header_style="bold magenta",
    )
    table.add_column("Assignment ID", style="cyan", justify="right")
    table.add_column("Assignment Name", style="green")
    table.add_column("User ID", style="cyan", justify="right")

    for sub in ungraded:
        aid = str(sub.get("assignment_id"))
        table.add_row(aid, assignment_names.get(aid, ""), str(sub.get("user_id")))

    console.print(table)
    console.print(f"\n[dim]Total ungraded: {len(ungraded)}[/dim]")


# ============================================================================
# IAM Commands
# ============================================================================

def _rich_progress_callback(progress: Progress, task_id):
    """Create a progress callback for Rich progress bar."""
    def callback(current: int, total: int, message: str):
        if total > 0:
            progress.update(task_id, completed=current, total=total, description=f"[cyan]{message}")
        else:
            progress.update(task_id, description=f"[cyan]{message}")
    return callback


def _select_course() -> str:
    """Fetch Canvas courses and prompt the user to select one."""
    from edutools.canvas import CanvasLMS

    with console.status("[bold green]Fetching courses from Canvas...", spinner="dots"):
        canvas = CanvasLMS()
        courses = canvas.get_courses()

    if not courses:
        console.print("[yellow]No courses found.[/yellow]")
        raise typer.Exit()

    console.print()
    for i, c in enumerate(courses, 1):
        console.print(f"  [cyan]{i}[/cyan]. {c['name']} [dim](ID: {c['id']})[/dim]")
    console.print()

    choice = typer.prompt("Select a course", type=int)
    if choice < 1 or choice > len(courses):
        console.print("[red]Invalid selection.[/red]")
        raise typer.Exit(1)

    return str(courses[choice - 1]["id"])


def _select_assignment(course_id: str) -> str:
    """Fetch assignments for a course and prompt the user to select one."""
    from edutools.canvas import CanvasLMS

    with console.status("[bold green]Fetching assignments from Canvas...", spinner="dots"):
        canvas = CanvasLMS()
        assignments = canvas.get_assignments(course_id)

    if not assignments:
        console.print("[yellow]No assignments found.[/yellow]")
        raise typer.Exit()

    console.print()
    for i, a in enumerate(assignments, 1):
        console.print(f"  [cyan]{i}[/cyan]. {a['name']} [dim](ID: {a['id']})[/dim]")
    console.print()

    choice = typer.prompt("Select an assignment", type=int)
    if choice < 1 or choice > len(assignments):
        console.print("[red]Invalid selection.[/red]")
        raise typer.Exit(1)

    return str(assignments[choice - 1]["id"])


@iam_app.command("provision", rich_help_panel="Workflow")
def provision_users(course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)")):
    """Create IAM users for all students in a course."""
    init()
    from edutools.iam import provision_students

    if course_id is None:
        course_id = _select_course()

    console.print(Panel.fit(
        "[bold green]IAM User Provisioning[/bold green]\n"
        f"Course ID: [cyan]{course_id}[/cyan]\n"
        "Region: [yellow]us-west-2[/yellow] (EC2 only)",
        title="☁️ AWS IAM",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = provision_students(course_id, progress_callback=_rich_progress_callback(progress, task))

    _display_iam_results(results, "created", "🚀 Provisioning Results", show_password=True)

    if results:
        filename = f"provisioned_{course_id}.csv"
        with open(filename, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["email", "username", "password", "status"])
            writer.writeheader()
            for r in results:
                writer.writerow({
                    "email": r.get("email", ""),
                    "username": r.get("username", ""),
                    "password": r.get("password", ""),
                    "status": r.get("status", ""),
                })
        console.print(f"\n[green]Results written to [bold]{filename}[/bold][/green]")


@iam_app.command("email-credentials", no_args_is_help=True, rich_help_panel="Workflow")
def email_credentials(
    csv_file: str = typer.Argument(..., help="CSV file generated by 'iam provision'"),
    sender_name: str = typer.Option("Course Instructor", "--sender", "-s", help="Name to use in email signature"),
    all_students: bool = typer.Option(False, "--all", "-a", help="Email all students without prompting"),
    test_email: Optional[str] = typer.Option(None, "--test", "-t", help="Send a test email to this address instead of students"),
):
    """Email IAM credentials to students from a CSV."""
    init()
    import os
    from edutools.iam import IAMProvisioner
    from edutools.google import send_email

    if not os.path.exists(csv_file):
        console.print(f"[red]File not found: {csv_file}[/red]")
        raise typer.Exit(1)

    with open(csv_file, newline="") as f:
        reader = csv.DictReader(f)
        rows = [r for r in reader if r.get("status") == "created" and r.get("email")]

    if not rows:
        console.print("[yellow]No successfully created users found in CSV.[/yellow]")
        raise typer.Exit()

    if test_email:
        selected = [rows[0]]
    elif all_students:
        selected = rows
    else:
        console.print()
        console.print(f"  [cyan]0[/cyan]. All students")
        for i, row in enumerate(rows, 1):
            console.print(f"  [cyan]{i}[/cyan]. {row['email']} [dim]({row['username']})[/dim]")
        console.print()

        choices = typer.prompt("Select students (comma-separated numbers, or 0 for all)")
        nums = [int(n.strip()) for n in choices.split(",")]

        if 0 in nums:
            selected = rows
        else:
            selected = []
            for n in nums:
                if n < 1 or n > len(rows):
                    console.print(f"[red]Invalid selection: {n}[/red]")
                    raise typer.Exit(1)
                selected.append(rows[n - 1])

    iam = IAMProvisioner()
    sign_in_url = iam.get_sign_in_url()

    if test_email:
        console.print(Panel.fit(
            "[bold yellow]TEST MODE[/bold yellow]\n"
            f"Sending to: [cyan]{test_email}[/cyan]\n"
            f"Using sample data from: [dim]{selected[0]['email']}[/dim]\n"
            f"Sign-in URL: [yellow]{sign_in_url}[/yellow]\n"
            f"Sender: [cyan]{sender_name}[/cyan]",
            title="📧 Gmail Test",
        ))
    else:
        console.print(Panel.fit(
            "[bold green]Email Credentials[/bold green]\n"
            f"File: [cyan]{csv_file}[/cyan]\n"
            f"Students: [cyan]{len(selected)}[/cyan]\n"
            f"Sign-in URL: [yellow]{sign_in_url}[/yellow]\n"
            f"Sender: [cyan]{sender_name}[/cyan]",
            title="📧 Gmail",
        ))

    results = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Sending emails...", total=len(selected))
        for i, row in enumerate(selected, 1):
            recipient = test_email if test_email else row["email"]
            username = row["username"]
            password = row["password"]

            progress.update(task, completed=i, description=f"[cyan]Emailing {recipient}")

            subject = "Your AWS Account Credentials"
            body_text = (
                f"Hello,\n\n"
                f"Your AWS IAM account has been created. Here are your login credentials:\n\n"
                f"Sign-in URL: {sign_in_url}\n"
                f"Username: {username}\n"
                f"Temporary Password: {password}\n\n"
                f"IMPORTANT: You will be required to change your password on first login.\n\n"
                f"Your account has permissions to use EC2 (virtual machines) in the us-west-2 region only.\n\n"
                f"Best regards,\n{sender_name}\n"
            )

            email_sent = False
            try:
                result = send_email(to=recipient, subject=subject, body_text=body_text)
                email_sent = result.get("success", False)
                if not email_sent:
                    console.print(f"[red]Failed to email {recipient}: {result.get('error', 'unknown error')}[/red]")
            except Exception as e:
                console.print(f"[red]Failed to email {recipient}: {e}[/red]")

            results.append({"email": recipient, "sent": email_sent})

    sent_count = sum(1 for r in results if r["sent"])
    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(results)} | "
        f"[green]Sent:[/green] {sent_count} | "
        f"[red]Failed:[/red] {len(results) - sent_count}",
        title="📊 Email Summary",
    ))


@iam_app.command("deprovision", rich_help_panel="Workflow")
def deprovision_users(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
):
    """Remove IAM users for all students in a course."""
    init()

    if course_id is None:
        course_id = _select_course()

    if not confirm:
        confirm = typer.confirm(f"⚠️  This will DELETE all IAM users for course {course_id}. Continue?")
        if not confirm:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit()

    from edutools.iam import deprovision_students

    console.print(Panel.fit(
        "[bold red]IAM User Deprovisioning[/bold red]\n"
        f"Course ID: [cyan]{course_id}[/cyan]",
        title="☁️ AWS IAM",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = deprovision_students(course_id, progress_callback=_rich_progress_callback(progress, task))

    _display_iam_results(results, "deleted", "🗑️ Deprovisioning Results")


@iam_app.command("reset-passwords", no_args_is_help=True, rich_help_panel="Management")
def reset_passwords(course_id: str = typer.Argument(..., help="Canvas course ID")):
    """Reset passwords for all students in a course."""
    init()
    from edutools.iam import reset_student_passwords

    console.print(Panel.fit(
        "[bold yellow]Password Reset[/bold yellow]\n"
        f"Course ID: [cyan]{course_id}[/cyan]",
        title="☁️ AWS IAM",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = reset_student_passwords(course_id, progress_callback=_rich_progress_callback(progress, task))

    _display_iam_results(results, "reset", "🔑 Password Reset Results", show_password=True)


@iam_app.command("reset-password", no_args_is_help=True, rich_help_panel="Management")
def reset_password(username: str = typer.Argument(..., help="IAM username to reset")):
    """Reset password for a single IAM user."""
    init()
    from edutools.iam import IAMProvisioner

    with console.status(f"[bold yellow]Resetting password for {username}...", spinner="dots"):
        iam = IAMProvisioner()
        result = iam.reset_password(username)

    if result["status"] == "reset":
        console.print(Panel.fit(
            f"[bold green]Password Reset Successful[/bold green]\n\n"
            f"Username: [cyan]{username}[/cyan]\n"
            f"New Password: [yellow]{result['password']}[/yellow]\n\n"
            "[dim]User will be required to change password on next login.[/dim]",
            title="🔑 AWS IAM",
        ))
    else:
        console.print(f"[red]Failed to reset password for {username}: {result.get('error', 'unknown error')}[/red]")
        raise typer.Exit(1)


@iam_app.command("update-policy", rich_help_panel="Management")
def update_policy(course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)")):
    """Update EC2 policy for all students in a course."""
    init()
    from edutools.iam import update_student_policies

    if course_id is None:
        course_id = _select_course()

    console.print(Panel.fit(
        "[bold blue]Policy Update[/bold blue]\n"
        f"Course ID: [cyan]{course_id}[/cyan]\n"
        "Policy: [yellow]EC2 access in us-west-2 only[/yellow]",
        title="☁️ AWS IAM",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = update_student_policies(course_id, progress_callback=_rich_progress_callback(progress, task))

    _display_iam_results(results, "updated", "📜 Policy Update Results")


def _display_iam_results(results: list, success_status: str, title: str, show_password: bool = False):
    """Display IAM operation results in a fancy table."""
    if not results:
        console.print("[yellow]No students found in course.[/yellow]")
        return

    table = Table(title=title, show_header=True, header_style="bold magenta")
    table.add_column("Email", style="cyan")
    table.add_column("Username", style="green")
    if show_password:
        table.add_column("Password", style="yellow")
    table.add_column("Status", justify="center")

    for r in results:
        status = r["status"]
        if status == success_status:
            status_display = f"[green]✓ {status}[/green]"
        elif status == "skipped":
            status_display = f"[yellow]⊘ {status}[/yellow]"
        else:
            status_display = f"[red]✗ {status}[/red]"

        row = [
            r.get("email", "N/A"),
            r.get("username") or "[dim]N/A[/dim]",
        ]
        if show_password:
            row.append(r.get("password") or "[dim]N/A[/dim]")
        row.append(status_display)

        table.add_row(*row)

    console.print(table)

    # Summary
    success_count = sum(1 for r in results if r["status"] == success_status)
    skipped_count = sum(1 for r in results if r["status"] == "skipped")
    error_count = sum(1 for r in results if r["status"] == "error")

    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(results)} | "
        f"[green]✓ {success_status.title()}:[/green] {success_count} | "
        f"[yellow]⊘ Skipped:[/yellow] {skipped_count} | "
        f"[red]✗ Errors:[/red] {error_count}",
        title="📊 Summary",
    ))



# ============================================================================
# EC2 Commands
# ============================================================================

def _select_launch_template() -> str:
    """Fetch AWS Launch Templates and prompt the user to select one."""
    from edutools.ec2 import EC2Provisioner

    with console.status("[bold green]Fetching launch templates...", spinner="dots"):
        ec2 = EC2Provisioner()
        templates = ec2.list_launch_templates()

    if not templates:
        console.print("[red]No launch templates found in your AWS account.[/red]")
        raise typer.Exit(1)

    console.print()
    for i, t in enumerate(templates, 1):
        console.print(f"  [cyan]{i}[/cyan]. {t['name']} [dim]({t['id']})[/dim]")
    console.print()

    choice = typer.prompt("Select a launch template", type=int)
    if choice < 1 or choice > len(templates):
        console.print("[red]Invalid selection.[/red]")
        raise typer.Exit(1)

    return templates[choice - 1]["name"]


@ec2_app.command("launch", rich_help_panel="Workflow")
def launch_vms(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    launch_template: Optional[str] = typer.Option(None, "--template", "-l", help="AWS Launch Template name or ID (prompted if omitted)"),
):
    """Launch EC2 instances for all students in a course.

    Launches one VM per student using an AWS Launch Template.  For each
    student a unique SSH key pair is generated and uploaded to a Google
    Drive folder named after the course.
    """
    init()
    import json
    from edutools.ec2 import SSH_SCRIPT_FILENAME, launch_student_vms, build_connection_doc, build_ssh_script
    from edutools.canvas import CanvasLMS
    import edutools.google as google_helpers

    if course_id is None:
        course_id = _select_course()

    if launch_template is None:
        launch_template = _select_launch_template()

    from edutools.ec2 import INSTRUCTOR_KEY_FILENAME

    instructor_key = os.path.join(CONFIG_DIR, INSTRUCTOR_KEY_FILENAME)
    if not os.path.exists(instructor_key):
        console.print(
            f"[red]Instructor key not found: {instructor_key}[/red]\n"
            f"[dim]Place your PEM file at {instructor_key} to continue.[/dim]"
        )
        raise typer.Exit(1)

    canvas = CanvasLMS()
    course_info = canvas.get_course(course_id)
    course_name = str(course_info["name"])

    console.print(Panel.fit(
        "[bold green]EC2 Instance Launch[/bold green]\n"
        f"Course: [cyan]{course_name}[/cyan] (ID: {course_id})\n"
        f"Launch Template: [yellow]{launch_template}[/yellow]\n"
        f"Instructor Key: [dim]{instructor_key}[/dim]\n"
        "[dim]A unique SSH key will be generated per student.\n"
        f"Keys will be uploaded to Google Drive folder: {course_name}[/dim]",
        title="🖥️ AWS EC2",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = launch_student_vms(
            course_id,
            launch_template=launch_template,
            instructor_key_path=instructor_key,
            progress_callback=_rich_progress_callback(progress, task),
        )

    if not results:
        console.print("[yellow]No students found in course.[/yellow]")
        return

    table = Table(title="🖥️ EC2 Launch Results", show_header=True, header_style="bold magenta")
    table.add_column("Email", style="cyan")
    table.add_column("Username", style="green")
    table.add_column("Instance ID", style="yellow")
    table.add_column("Public IP", style="yellow")
    table.add_column("Status", justify="center")

    for r in results:
        status = r["status"]
        if status == "launched":
            status_display = "[green]✓ launched[/green]"
        elif status == "skipped":
            status_display = "[yellow]⊘ skipped[/yellow]"
        else:
            status_display = f"[red]✗ {status}[/red]"

        table.add_row(
            r.get("email", "N/A"),
            r.get("username") or "[dim]N/A[/dim]",
            r.get("instance_id") or "[dim]N/A[/dim]",
            r.get("public_ip") or "[dim]N/A[/dim]",
            status_display,
        )

    console.print(table)

    # Upload manifest and per-student keys to Google Drive
    launched = [r for r in results if r["status"] == "launched" and r.get("username")]

    if not launched:
        console.print("[yellow]No instances launched — skipping Drive upload.[/yellow]")
    else:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as progress:
            total = len(launched) + 2  # folder + manifest + per-student
            task = progress.add_task("[cyan]Uploading to Google Drive...", total=total)

            # Create top-level course folder
            progress.update(task, completed=1, description=f"[cyan]Creating Drive folder '{course_name}'...")
            course_folder_id = google_helpers.create_folder(course_name)

            # Upload manifest.json
            progress.update(task, completed=2, description="[cyan]Uploading manifest.json...")
            manifest_entries = [
                {
                    "email": r["email"],
                    "username": r["username"],
                    "instance_id": r["instance_id"],
                    "public_ip": r["public_ip"],
                    "status": r["status"],
                }
                for r in launched
            ]
            google_helpers.upload_text_file(
                "manifest.json",
                json.dumps(manifest_entries, indent=2),
                course_folder_id,
            )

            # Create per-student subfolders with keys and connection docs
            for i, r in enumerate(launched, 1):
                username = r["username"]
                progress.update(
                    task,
                    completed=2 + i,
                    description=f"[cyan]Uploading keys for {username}...",
                )
                student_folder_id = google_helpers.create_folder(
                    f"VM Access - {username}", parent_id=course_folder_id,
                )
                script = build_ssh_script(
                    username=username,
                    public_ip=r["public_ip"],
                    instance_id=r["instance_id"],
                    private_key=r["private_key"],
                )
                google_helpers.upload_text_file(SSH_SCRIPT_FILENAME, script, student_folder_id)
                doc_text = build_connection_doc(
                    username=username,
                    public_ip=r["public_ip"],
                    instance_id=r["instance_id"],
                )
                google_helpers.create_doc_with_content(
                    f"Connection Details - {username}", doc_text, folder_id=student_folder_id,
                )

        console.print(f"\n[green]Keys uploaded to Google Drive folder: [bold]{course_name}[/bold][/green]")

    # Summary
    launched_count = sum(1 for r in results if r["status"] == "launched")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    errors = sum(1 for r in results if r["status"] not in ("launched", "skipped"))

    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(results)} | "
        f"[green]✓ Launched:[/green] {launched_count} | "
        f"[yellow]⊘ Skipped:[/yellow] {skipped} | "
        f"[red]✗ Errors:[/red] {errors}",
        title="📊 Summary",
    ))


@ec2_app.command("check-launch", rich_help_panel="Checks")
def ec2_check_launch(
    launch_template: Optional[str] = typer.Option(None, "--template", "-l", help="AWS Launch Template name or ID (prompted if omitted)"),
):
    """Launch a test VM and verify SSH key login.

    Launches a single instance, SSHes in with the instructor key to
    configure a test user, and verifies login as the test user.  The
    instance is left running for inspection — use [cyan]ec2 check-cleanup[/cyan]
    to terminate.
    """
    init()
    from edutools.ec2 import INSTRUCTOR_KEY_FILENAME, check_ec2_launch

    if launch_template is None:
        launch_template = _select_launch_template()

    instructor_key = os.path.join(CONFIG_DIR, INSTRUCTOR_KEY_FILENAME)
    if not os.path.exists(instructor_key):
        console.print(
            f"[red]Instructor key not found: {instructor_key}[/red]\n"
            f"[dim]Place your PEM file at {instructor_key} to continue.[/dim]"
        )
        raise typer.Exit(1)

    console.print(Panel.fit(
        "[bold green]EC2 End-to-End Check[/bold green]\n"
        f"Launch Template: [yellow]{launch_template}[/yellow]\n"
        f"Instructor Key: [dim]{instructor_key}[/dim]\n\n"
        "[dim]This will launch a test instance, configure a test user\n"
        "via the instructor key, and verify SSH login.\n"
        "The instance will be left running — use 'ec2 check-cleanup' to terminate.[/dim]",
        title="🖥️ AWS EC2",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=5)
        result = check_ec2_launch(
            launch_template=launch_template,
            instructor_key_path=instructor_key,
            progress_callback=_rich_progress_callback(progress, task),
        )

    passed = result["status"] == "passed"
    border = "green" if passed else "red"
    status_icon = "[green]✓ PASSED[/green]" if passed else "[red]✗ FAILED[/red]"

    lines = [
        f"Status: {status_icon}",
        "",
        f"Instance ID: [cyan]{result['instance_id'] or 'N/A'}[/cyan]",
        f"Public IP:   [cyan]{result['public_ip'] or 'N/A'}[/cyan]",
        f"Test User:   [cyan]{result['username']}[/cyan]",
    ]

    if result["ssh_output"]:
        lines += ["", f"SSH Output:  [green]{result['ssh_output']}[/green]"]

    if not passed:
        lines += ["", f"Error:       [red]{result['status']}[/red]"]

    if result.get("instance_id"):
        lines.append("\n[yellow]Instance left running — run 'edutools ec2 check-cleanup' to terminate.[/yellow]")

    console.print(Panel.fit(
        "\n".join(lines),
        title="🔍 EC2 Check Results",
        border_style=border,
    ))

    if not passed:
        raise typer.Exit(1)


@ec2_app.command("check-cleanup", rich_help_panel="Checks")
def ec2_check_cleanup(
    confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
):
    """Terminate test instances from [cyan]check-launch[/cyan]."""
    init()
    from edutools.ec2 import EC2Provisioner, cleanup_check_instances

    ec2 = EC2Provisioner()
    resp = ec2.ec2.describe_instances(
        Filters=[
            {"Name": "tag:edutools-check", "Values": ["true"]},
            {"Name": "instance-state-name", "Values": [
                "pending", "running", "stopping", "stopped",
            ]},
        ],
    )

    preview: list[dict[str, str]] = []
    for reservation in resp["Reservations"]:
        for inst in reservation["Instances"]:
            preview.append({
                "instance_id": inst["InstanceId"],
                "state": inst["State"]["Name"],
                "public_ip": inst.get("PublicIpAddress", ""),
            })

    if not preview:
        console.print("[yellow]No check instances found.[/yellow]")
        return

    table = Table(title="EC2 Check Instances", show_header=True, header_style="bold magenta")
    table.add_column("Instance ID", style="cyan")
    table.add_column("State", style="yellow")
    table.add_column("Public IP", style="yellow")

    for inst in preview:
        table.add_row(
            inst["instance_id"],
            inst["state"],
            inst["public_ip"] or "[dim]N/A[/dim]",
        )

    console.print(table)
    console.print()

    if not confirm:
        confirm = typer.confirm(f"Terminate {len(preview)} check instance(s)?")
        if not confirm:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Terminating...", total=None)
        results = cleanup_check_instances(
            progress_callback=_rich_progress_callback(progress, task),
        )

    terminated = sum(1 for r in results if r["status"] == "terminated")
    errors = len(results) - terminated

    console.print()
    console.print(Panel.fit(
        f"[green]✓ Terminated:[/green] {terminated}"
        + (f" | [red]✗ Errors:[/red] {errors}" if errors else ""),
        title="🧹 Cleanup Summary",
    ))


@maintenance_app.command("check-ssh")
def ec2_check_ssh(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    log_file: str = typer.Option("ssh-failures.log", "--log", "-o", help="File to write unreachable instances"),
    timeout: int = typer.Option(30, "--timeout", "-t", help="SSH connection timeout in seconds"),
):
    """Check SSH access on all running instances for a course.

    Attempts to connect to every running EC2 instance tagged with
    the given course ID using the instructor key.  Instances that
    cannot be reached are logged to a file for further action.
    """
    init()
    from edutools.ec2 import INSTRUCTOR_KEY_FILENAME, check_ssh_access

    if course_id is None:
        course_id = _select_course()

    instructor_key_path = os.path.join(CONFIG_DIR, INSTRUCTOR_KEY_FILENAME)
    if not os.path.isfile(instructor_key_path):
        console.print(
            f"[red]Instructor key not found:[/red] {instructor_key_path}\n"
            f"[dim]Place your EC2 instructor PEM key at the path above.[/dim]"
        )
        raise typer.Exit(1)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Checking SSH...", total=None)
        results = check_ssh_access(
            course_id,
            instructor_key_path=instructor_key_path,
            log_file=log_file,
            ssh_timeout=timeout,
            progress_callback=_rich_progress_callback(progress, task),
        )

    if not results:
        console.print("[yellow]No running instances found for this course.[/yellow]")
        return

    table = Table(title="SSH Access Check", show_header=True, header_style="bold magenta")
    table.add_column("Instance ID", style="cyan")
    table.add_column("Student")
    table.add_column("Public IP", style="yellow")
    table.add_column("Status")

    for r in results:
        if r["status"] == "ok":
            status_display = "[green]✓ reachable[/green]"
        else:
            status_display = f"[red]✗ {r['status']}[/red]"
        table.add_row(r["instance_id"], r["student"] or "[dim]N/A[/dim]", r["public_ip"], status_display)

    console.print(table)
    console.print()

    ok = sum(1 for r in results if r["status"] == "ok")
    failed = len(results) - ok

    summary = f"[green]✓ Reachable:[/green] {ok}"
    if failed:
        summary += f" | [red]✗ Unreachable:[/red] {failed} (logged to {log_file})"

    console.print(Panel.fit(summary, title="SSH Check Summary"))


@maintenance_app.command("reboot-failed")
def ec2_reboot_failed(
    log_file: str = typer.Option("ssh-failures.log", "--log", "-i", help="SSH failure log file from check-ssh"),
    timeout: int = typer.Option(300, "--timeout", "-t", help="Seconds to wait for each instance to come back online"),
):
    """Reboot unreachable instances and wait for them to come back online.

    Reads the failure log produced by [cyan]maintenance check-ssh[/cyan],
    reboots all listed instances at once, then polls SSH on each until it
    becomes reachable again (or the timeout is exceeded).
    """
    init()
    import json
    from edutools.aws import INSTRUCTOR_KEY_FILENAME, reboot_failed_instances

    if not os.path.isfile(log_file):
        console.print(f"[red]Log file not found:[/red] {log_file}")
        console.print("[dim]Run 'maintenance check-ssh' first to generate the failure log.[/dim]")
        raise typer.Exit(1)

    instructor_key_path = os.path.join(CONFIG_DIR, INSTRUCTOR_KEY_FILENAME)
    if not os.path.isfile(instructor_key_path):
        console.print(
            f"[red]Instructor key not found:[/red] {instructor_key_path}\n"
            f"[dim]Place your EC2 instructor PEM key at the path above.[/dim]"
        )
        raise typer.Exit(1)

    with open(log_file) as f:
        log_data = json.load(f)

    course_id = log_data.get("course_id", "")
    entries = log_data.get("instances", [])
    if not entries:
        console.print("[yellow]No failed instances in the log file.[/yellow]")
        return

    console.print(Panel.fit(
        f"[bold green]Reboot Failed Instances[/bold green]\n"
        f"Log file:   [cyan]{log_file}[/cyan]\n"
        f"Course ID:  [cyan]{course_id}[/cyan]\n"
        f"Instances:  [cyan]{len(entries)}[/cyan]",
    ))
    console.print()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Rebooting...", total=None)
        results = reboot_failed_instances(
            log_file,
            instructor_key_path=instructor_key_path,
            ssh_timeout=timeout,
            progress_callback=_rich_progress_callback(progress, task),
        )

    if not results:
        console.print("[yellow]No instances to process.[/yellow]")
        return

    table = Table(title="Reboot Results", show_header=True, header_style="bold magenta")
    table.add_column("Instance ID", style="cyan")
    table.add_column("Student")
    table.add_column("Public IP")
    table.add_column("Status")

    for r in results:
        status = r["status"]
        if status == "online":
            status_display = "[green]online[/green]"
        else:
            status_display = f"[red]{status}[/red]"
        table.add_row(
            r["instance_id"],
            r["student"] or "[dim]N/A[/dim]",
            r["public_ip"] or "[dim]N/A[/dim]",
            status_display,
        )

    console.print(table)
    console.print()

    online = sum(1 for r in results if r["status"] == "online")
    failed = len(results) - online
    summary = f"[green]✓ Online:[/green] {online}"
    if failed:
        summary += f" | [red]✗ Unreachable:[/red] {failed}"
    console.print(Panel.fit(summary, title="Reboot Summary"))


@ec2_app.command("check-email", rich_help_panel="Checks")
def ec2_check_email():
    """Test Google Drive + Gmail without launching a VM.

    Creates a test folder with dummy data, shares it, and sends an
    email to shanepanter@u.boisestate.edu.  For a full end-to-end check
    with a real VM, use [cyan]ec2 run-all --check[/cyan] instead.

    Use [cyan]google check-cleanup[/cyan] to remove the test folder afterwards.
    """
    init()
    import json
    from edutools.ec2 import SSH_SCRIPT_FILENAME, build_connection_doc, build_ssh_script
    import edutools.google as google_helpers
    from edutools.google import send_email

    test_email = "shanepanter@u.boisestate.edu"
    test_course = "edutools-check-CS-101"
    test_username = test_email.split("@")[0]
    test_ip = "192.0.2.1"
    test_instance_id = "i-0000000000check"

    console.print(Panel.fit(
        "[bold green]EC2 Email Check[/bold green]\n"
        f"Course folder: [cyan]{test_course}[/cyan]\n"
        f"Test student:  [cyan]{test_username}[/cyan]\n"
        f"Test email:    [cyan]{test_email}[/cyan]\n"
        "[dim]Simulates the full launch → share → email workflow.\n"
        "Use 'google check-cleanup' to remove afterwards.[/dim]",
        title="📧 EC2 Email Check",
    ))

    course_folder_id = ""
    subfolder_id = ""
    steps_passed = 0
    total_steps = 6
    status = "error"
    error_detail = ""

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=total_steps)

        try:
            # Step 1: Create course folder (like ec2 launch)
            progress.update(task, completed=1, description=f"[cyan]Creating course folder '{test_course}'...")
            course_folder_id = google_helpers.create_folder(test_course)
            steps_passed += 1

            # Step 2: Upload manifest.json (like ec2 launch)
            progress.update(task, completed=2, description="[cyan]Uploading manifest.json...")
            manifest = [
                {
                    "email": test_email,
                    "username": test_username,
                    "instance_id": test_instance_id,
                    "public_ip": test_ip,
                    "status": "launched",
                }
            ]
            google_helpers.upload_text_file(
                "manifest.json", json.dumps(manifest, indent=2), course_folder_id,
            )
            steps_passed += 1

            # Step 3: Create student subfolder with key + doc (like ec2 launch)
            progress.update(task, completed=3, description=f"[cyan]Creating subfolder for {test_username}...")
            subfolder_id = google_helpers.create_folder(
                f"VM Access - {test_username}", parent_id=course_folder_id,
            )
            script = build_ssh_script(
                username=test_username,
                public_ip=test_ip,
                instance_id=test_instance_id,
                private_key="--- DUMMY TEST KEY ---",
            )
            google_helpers.upload_text_file(SSH_SCRIPT_FILENAME, script, subfolder_id)
            doc_text = build_connection_doc(
                username=test_username,
                public_ip=test_ip,
                instance_id=test_instance_id,
            )
            google_helpers.create_doc_with_content(
                f"Connection Details - {test_username}", doc_text, folder_id=subfolder_id,
            )
            steps_passed += 1

            # Step 4: Share subfolder (like ec2 share-keys)
            progress.update(task, completed=4, description=f"[cyan]Sharing with {test_email}...")
            google_helpers.share_with_user(subfolder_id, test_email)
            steps_passed += 1

            # Step 5: Send email with link (like ec2 email-credentials)
            progress.update(task, completed=5, description=f"[cyan]Sending email to {test_email}...")
            folder_link = f"https://drive.google.com/drive/folders/{subfolder_id}"
            subject = "Your Virtual Machine Access"
            body_text = (
                f"Hello,\n\n"
                f"A virtual machine has been set up for you. Your SSH key and\n"
                f"connection instructions are in the Google Drive folder below:\n\n"
                f"    {folder_link}\n\n"
                f"Open the folder and follow the instructions in the\n"
                f"'Connection Details' document to get started.\n\n"
                f"Best regards,\nCourse Instructor\n"
            )
            result = send_email(to=test_email, subject=subject, body_text=body_text)
            if not result.get("success"):
                raise RuntimeError(result.get("error", "unknown email error"))
            steps_passed += 1

            # Step 6: Verify folder structure
            progress.update(task, completed=6, description="[cyan]Verifying folder structure...")
            course_contents = google_helpers.list_folder_contents(course_folder_id)
            has_manifest = any(f["name"] == "manifest.json" for f in course_contents)
            has_subfolder = any(
                f["name"] == f"VM Access - {test_username}" for f in course_contents
            )
            if not has_manifest or not has_subfolder:
                missing = []
                if not has_manifest:
                    missing.append("manifest.json")
                if not has_subfolder:
                    missing.append(f"VM Access - {test_username}")
                raise RuntimeError(f"Missing in course folder: {', '.join(missing)}")
            sub_contents = google_helpers.list_folder_contents(subfolder_id)
            if len(sub_contents) < 2:
                raise RuntimeError(
                    f"Expected at least 2 items in student subfolder, found {len(sub_contents)}"
                )
            steps_passed += 1

            status = "passed"

        except Exception as e:
            error_detail = str(e)

    passed = status == "passed"
    border = "green" if passed else "red"
    status_icon = "[green]✓ PASSED[/green]" if passed else "[red]✗ FAILED[/red]"

    lines = [
        f"Status: {status_icon}",
        "",
        f"Steps completed: [cyan]{steps_passed}/{total_steps}[/cyan]",
        f"Course folder:   [cyan]{test_course}[/cyan]",
        f"Test email:      [cyan]{test_email}[/cyan]",
    ]
    if subfolder_id:
        folder_link = f"https://drive.google.com/drive/folders/{subfolder_id}"
        lines.append(f"Folder link:     [cyan]{folder_link}[/cyan]")
    if error_detail:
        lines += ["", f"Error: [red]{error_detail}[/red]"]

    lines.append("\n[yellow]Test folder left in Drive — run 'edutools google check-cleanup' to remove.[/yellow]")

    console.print(Panel.fit(
        "\n".join(lines),
        title="🔍 EC2 Email Check Results",
        border_style=border,
    ))

    if not passed:
        raise typer.Exit(1)


@ec2_app.command("share-keys", rich_help_panel="Workflow")
def share_keys(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
):
    """Share SSH key folders with students via Google Drive.

    Finds the Google Drive folder created by [cyan]ec2 launch[/cyan] and
    shares each student's subfolder with them.
    """
    init()
    import json
    from edutools.canvas import CanvasLMS
    import edutools.google as google_helpers

    if course_id is None:
        course_id = _select_course()

    canvas = CanvasLMS()
    course_info = canvas.get_course(course_id)
    course_name = str(course_info["name"])

    # Find the course folder in Drive
    folders = google_helpers.find_files_by_name(
        course_name, mime_type="application/vnd.google-apps.folder",
    )
    if not folders:
        console.print(f"[red]No Drive folder found for '{course_name}'.[/red]")
        console.print("[dim]Run 'ec2 launch' first.[/dim]")
        raise typer.Exit(1)

    folder_id = folders[0]["id"]

    # Find and download manifest
    contents = google_helpers.list_folder_contents(folder_id)
    manifest_files = [f for f in contents if f["name"] == "manifest.json"]
    if not manifest_files:
        console.print(f"[red]manifest.json not found in Drive folder '{course_name}'.[/red]")
        raise typer.Exit(1)

    manifest_json = google_helpers.download_text_file(manifest_files[0]["id"])
    entries: list[dict[str, str]] = json.loads(manifest_json)

    if not entries:
        console.print("[yellow]No launched instances found in manifest.[/yellow]")
        raise typer.Exit()

    # Build a map of student subfolder names to IDs
    student_folders = {
        f["name"]: f["id"]
        for f in contents
        if f["mimeType"] == "application/vnd.google-apps.folder"
    }

    console.print(Panel.fit(
        "[bold green]Share SSH Keys via Google Drive[/bold green]\n"
        f"Course: [cyan]{course_name}[/cyan]\n"
        f"Students: [cyan]{len(entries)}[/cyan]",
        title="📁 Google Drive",
    ))

    results: list[dict[str, str]] = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Sharing keys...", total=len(entries))

        for i, entry in enumerate(entries, 1):
            username = entry["username"]
            email = entry["email"]

            progress.update(task, completed=i, description=f"[cyan]Sharing with {email}")

            subfolder_name = f"VM Access - {username}"
            subfolder_id = student_folders.get(subfolder_name)
            if not subfolder_id:
                results.append({"email": email, "status": "error: subfolder not found"})
                continue

            try:
                google_helpers.share_with_user(subfolder_id, email)
                results.append({"email": email, "status": "shared"})
            except Exception as e:
                results.append({"email": email, "status": f"error: {e}"})

    # Results table
    table = Table(title="📁 Share Results", show_header=True, header_style="bold magenta")
    table.add_column("Email", style="cyan")
    table.add_column("Status", justify="center")

    for r in results:
        status = r["status"]
        if status == "shared":
            status_display = "[green]✓ shared[/green]"
        else:
            status_display = f"[red]✗ {status}[/red]"
        table.add_row(r["email"], status_display)

    console.print(table)

    shared_count = sum(1 for r in results if r["status"] == "shared")
    error_count = len(results) - shared_count

    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(results)} | "
        f"[green]✓ Shared:[/green] {shared_count} | "
        f"[red]✗ Errors:[/red] {error_count}",
        title="📊 Summary",
    ))


@ec2_app.command("email-credentials", rich_help_panel="Workflow")
def ec2_email_credentials(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    sender_name: str = typer.Option("Course Instructor", "--sender", "-s", help="Name to use in email signature"),
    all_students: bool = typer.Option(False, "--all", "-a", help="Email all students without prompting"),
    test_email: Optional[str] = typer.Option(None, "--test", "-t", help="Send a test email to this address instead of students"),
):
    """Email students a link to their shared Drive folder.

    Reads the manifest from the Drive folder created by [cyan]ec2 launch[/cyan]
    and sends each student a short email with a link to their VM Access folder.
    Run [cyan]ec2 share-keys[/cyan] first so students have access.
    """
    init()
    import json
    from edutools.canvas import CanvasLMS
    import edutools.google as google_helpers
    from edutools.google import send_email

    if course_id is None:
        course_id = _select_course()

    canvas = CanvasLMS()
    course_info = canvas.get_course(course_id)
    course_name = str(course_info["name"])

    # Find the course folder in Drive
    folders = google_helpers.find_files_by_name(
        course_name, mime_type="application/vnd.google-apps.folder",
    )
    if not folders:
        console.print(f"[red]No Drive folder found for '{course_name}'.[/red]")
        console.print("[dim]Run 'ec2 launch' first.[/dim]")
        raise typer.Exit(1)

    folder_id = folders[0]["id"]

    # Find and download manifest
    contents = google_helpers.list_folder_contents(folder_id)
    manifest_files = [f for f in contents if f["name"] == "manifest.json"]
    if not manifest_files:
        console.print(f"[red]manifest.json not found in Drive folder '{course_name}'.[/red]")
        raise typer.Exit(1)

    manifest_json = google_helpers.download_text_file(manifest_files[0]["id"])
    entries: list[dict[str, str]] = json.loads(manifest_json)

    if not entries:
        console.print("[yellow]No launched instances found in manifest.[/yellow]")
        raise typer.Exit()

    # Build a map of student subfolder names to IDs
    student_folders = {
        f["name"]: f["id"]
        for f in contents
        if f["mimeType"] == "application/vnd.google-apps.folder"
    }

    if test_email:
        selected = [entries[0]]
    elif all_students:
        selected = entries
    else:
        console.print()
        console.print("  [cyan]0[/cyan]. All students")
        for i, entry in enumerate(entries, 1):
            console.print(
                f"  [cyan]{i}[/cyan]. {entry['email']} [dim]({entry['username']})[/dim]"
            )
        console.print()

        choices = typer.prompt("Select students (comma-separated numbers, or 0 for all)")
        nums = [int(n.strip()) for n in choices.split(",")]

        if 0 in nums:
            selected = entries
        else:
            selected = []
            for n in nums:
                if n < 1 or n > len(entries):
                    console.print(f"[red]Invalid selection: {n}[/red]")
                    raise typer.Exit(1)
                selected.append(entries[n - 1])

    if test_email:
        console.print(Panel.fit(
            "[bold yellow]TEST MODE[/bold yellow]\n"
            f"Sending to: [cyan]{test_email}[/cyan]\n"
            f"Using sample data from: [dim]{selected[0]['email']}[/dim]\n"
            f"Sender: [cyan]{sender_name}[/cyan]",
            title="📧 Gmail Test",
        ))
    else:
        console.print(Panel.fit(
            "[bold green]Email VM Access Links[/bold green]\n"
            f"Course: [cyan]{course_name}[/cyan]\n"
            f"Students: [cyan]{len(selected)}[/cyan]\n"
            f"Sender: [cyan]{sender_name}[/cyan]",
            title="📧 Gmail",
        ))

    email_results: list[dict[str, object]] = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Sending emails...", total=len(selected))
        for i, entry in enumerate(selected, 1):
            recipient = test_email if test_email else entry["email"]
            username = entry["username"]

            progress.update(task, completed=i, description=f"[cyan]Emailing {recipient}")

            subfolder_name = f"VM Access - {username}"
            subfolder_id = student_folders.get(subfolder_name)
            if not subfolder_id:
                console.print(f"[red]Subfolder not found for {username}[/red]")
                email_results.append({"email": recipient, "sent": False})
                continue

            folder_link = f"https://drive.google.com/drive/folders/{subfolder_id}"

            subject = "Your Virtual Machine Access"
            body_text = (
                f"Hello,\n\n"
                f"A virtual machine has been set up for you. Your SSH key and\n"
                f"connection instructions are in the Google Drive folder below:\n\n"
                f"    {folder_link}\n\n"
                f"Open the folder and follow the instructions in the\n"
                f"'Connection Details' document to get started.\n\n"
                f"Best regards,\n{sender_name}\n"
            )

            email_sent = False
            try:
                result = send_email(to=recipient, subject=subject, body_text=body_text)
                email_sent = result.get("success", False)
                if not email_sent:
                    console.print(
                        f"[red]Failed to email {recipient}: "
                        f"{result.get('error', 'unknown error')}[/red]"
                    )
            except Exception as e:
                console.print(f"[red]Failed to email {recipient}: {e}[/red]")

            email_results.append({"email": recipient, "sent": email_sent})

    sent_count = sum(1 for r in email_results if r["sent"])
    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(email_results)} | "
        f"[green]Sent:[/green] {sent_count} | "
        f"[red]Failed:[/red] {len(email_results) - sent_count}",
        title="📊 Email Summary",
    ))


def _run_all_check(
    *,
    launch_template: Optional[str],
    test_email: str,
) -> None:
    """Run the full workflow in check mode with a real VM.

    Mirrors the real launch → share pipeline using a single test student
    and a real EC2 instance.
    """
    import json
    from edutools.ec2 import (
        INSTRUCTOR_KEY_FILENAME,
        SSH_SCRIPT_FILENAME,
        build_connection_doc,
        build_ssh_script,
        check_ec2_launch,
    )
    import edutools.google as google_helpers

    if launch_template is None:
        launch_template = _select_launch_template()

    instructor_key = os.path.join(CONFIG_DIR, INSTRUCTOR_KEY_FILENAME)
    if not os.path.exists(instructor_key):
        console.print(
            f"[red]Instructor key not found: {instructor_key}[/red]\n"
            f"[dim]Place your PEM file at {instructor_key} to continue.[/dim]"
        )
        raise typer.Exit(1)

    test_course = "edutools-check-CS-101"
    test_username = test_email.split("@")[0]

    console.print(Panel.fit(
        "[bold yellow]CHECK MODE[/bold yellow]\n"
        f"Launch Template: [yellow]{launch_template}[/yellow]\n"
        f"Test course folder: [cyan]{test_course}[/cyan]\n"
        f"Test email: [cyan]{test_email}[/cyan]\n"
        "[dim]Mirrors the real workflow with a single test student.\n"
        "Use 'ec2 check-cleanup' and 'google check-cleanup' afterwards.[/dim]",
        title="🔍 Run All (Check)",
    ))

    passed = 0
    failed = 0
    step_results: list[tuple[str, str]] = []

    # ── Step 1: Launch VM ────────────────────────────────────────────────
    console.rule("[bold cyan]Launch VM[/bold cyan]")
    console.print()

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("[cyan]Starting...", total=5)
            vm_result = check_ec2_launch(
                launch_template=launch_template,
                instructor_key_path=instructor_key,
                username=test_username,
                progress_callback=_rich_progress_callback(progress, task),
            )

        vm_passed = vm_result["status"] == "passed"
        border = "green" if vm_passed else "red"
        status_icon = "[green]✓ PASSED[/green]" if vm_passed else "[red]✗ FAILED[/red]"

        lines = [
            f"Status: {status_icon}",
            "",
            f"Instance ID: [cyan]{vm_result['instance_id'] or 'N/A'}[/cyan]",
            f"Public IP:   [cyan]{vm_result['public_ip'] or 'N/A'}[/cyan]",
        ]
        if vm_result["ssh_output"]:
            lines += ["", f"SSH Output:  [green]{vm_result['ssh_output']}[/green]"]
        if not vm_passed:
            lines += ["", f"Error:       [red]{vm_result['status']}[/red]"]

        console.print(Panel.fit("\n".join(lines), title="🖥️ EC2 Launch", border_style=border))

        if not vm_passed:
            step_results.append(("Launch VM", "failed"))
            failed += 1
            console.print("\n[red]Launch failed — aborting remaining steps.[/red]")
            _run_all_check_summary(step_results, passed, failed)
            raise typer.Exit(1)

        step_results.append(("Launch VM", "passed"))
        passed += 1

        # Upload to Google Drive (part of the launch step, just like the real flow)
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("[cyan]Uploading to Google Drive...", total=3)

            progress.update(task, completed=1, description=f"[cyan]Creating Drive folder '{test_course}'...")
            course_folder_id = google_helpers.create_folder(test_course)

            progress.update(task, completed=2, description="[cyan]Uploading manifest.json...")
            manifest = [
                {
                    "email": test_email,
                    "username": test_username,
                    "instance_id": vm_result["instance_id"],
                    "public_ip": vm_result["public_ip"],
                    "status": "launched",
                }
            ]
            google_helpers.upload_text_file(
                "manifest.json", json.dumps(manifest, indent=2), course_folder_id,
            )

            progress.update(task, completed=3, description=f"[cyan]Uploading keys for {test_username}...")
            student_folder_id = google_helpers.create_folder(
                f"VM Access - {test_username}", parent_id=course_folder_id,
            )
            script = build_ssh_script(
                username=test_username,
                public_ip=vm_result["public_ip"],
                instance_id=vm_result["instance_id"],
                private_key=vm_result["private_key"],
            )
            google_helpers.upload_text_file(SSH_SCRIPT_FILENAME, script, student_folder_id)
            doc_text = build_connection_doc(
                username=test_username,
                public_ip=vm_result["public_ip"],
                instance_id=vm_result["instance_id"],
            )
            google_helpers.create_doc_with_content(
                f"Connection Details - {test_username}", doc_text, folder_id=student_folder_id,
            )

        console.print(f"\n[green]Keys uploaded to Drive folder: [bold]{test_course}[/bold][/green]")

    except typer.Exit:
        raise
    except Exception as e:
        step_results.append(("Launch VM", f"error: {e}"))
        failed += 1
        console.print(f"\n[red]Launch failed — {e}[/red]")
        _run_all_check_summary(step_results, passed, failed)
        raise typer.Exit(1)

    console.print()

    # ── Step 2: Share Keys ───────────────────────────────────────────────
    console.rule("[bold cyan]Share Keys[/bold cyan]")
    console.print()

    try:
        folders = google_helpers.find_files_by_name(
            test_course, mime_type="application/vnd.google-apps.folder",
        )
        if not folders:
            raise RuntimeError(f"Drive folder '{test_course}' not found")

        folder_id = folders[0]["id"]
        contents = google_helpers.list_folder_contents(folder_id)
        student_folders = {
            f["name"]: f["id"]
            for f in contents
            if f["mimeType"] == "application/vnd.google-apps.folder"
        }

        subfolder_name = f"VM Access - {test_username}"
        subfolder_id = student_folders.get(subfolder_name)
        if not subfolder_id:
            raise RuntimeError(f"Subfolder '{subfolder_name}' not found")

        with console.status(f"[bold green]Sharing with {test_email}...", spinner="dots"):
            google_helpers.share_with_user(subfolder_id, test_email)

        console.print(f"[green]✓ Shared '{subfolder_name}' with {test_email}[/green]")
        step_results.append(("Share Keys", "passed"))
        passed += 1

    except Exception as e:
        step_results.append(("Share Keys", f"error: {e}"))
        failed += 1
        console.print(f"\n[red]Share failed — {e}[/red]")
        _run_all_check_summary(step_results, passed, failed)
        raise typer.Exit(1)

    console.print()

    # ── Summary ──────────────────────────────────────────────────────────
    _run_all_check_summary(step_results, passed, failed)

    if failed > 0:
        raise typer.Exit(1)


def _run_all_check_summary(
    step_results: list[tuple[str, str]], passed: int, failed: int,
) -> None:
    """Print the check-mode summary panel."""
    console.rule("[bold]Summary[/bold]")
    lines: list[str] = []
    for name, status in step_results:
        if status == "passed":
            lines.append(f"  [green]✓[/green] {name}")
        else:
            lines.append(f"  [red]✗[/red] {name} — {status}")

    console.print(Panel.fit(
        "\n".join(lines) + "\n\n"
        f"[green]✓ Passed:[/green] {passed} | "
        f"[red]✗ Failed:[/red] {failed}",
        title="📊 Run All Summary",
        border_style="green" if failed == 0 else "red",
    ))

    if passed > 0 or failed > 0:
        console.print(
            "\n[yellow]Run 'edutools ec2 check-cleanup' and "
            "'edutools google check-cleanup' to clean up test resources.[/yellow]"
        )


@ec2_app.command("run-all", rich_help_panel="Workflow")
def run_all(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted; ignored with --check)"),
    launch_template: Optional[str] = typer.Option(None, "--template", "-l", help="AWS Launch Template name or ID (prompted if omitted)"),
    check: bool = typer.Option(False, "--check", help="Run check versions of each step instead of real operations"),
    test_email: Optional[str] = typer.Option(None, "--test-email", "-t", help="Email address for --check mode (prompted if omitted)"),
):
    """Run the full workflow: launch → share keys.

    Runs each step in order: launch VMs, then share Drive folders with
    students.  Google sends a notification email when the folder is shared.

    With [yellow]--check[/yellow], runs the real workflow against a single test
    VM.
    Use [cyan]ec2 check-cleanup[/cyan] and [cyan]google check-cleanup[/cyan] afterwards.
    """
    init()

    if check:
        email = test_email or typer.prompt(
            "Test email address", default="shanepanter@u.boisestate.edu",
        )
        _run_all_check(launch_template=launch_template, test_email=email)
        return

    if course_id is None:
        course_id = _select_course()
    if launch_template is None:
        launch_template = _select_launch_template()

    console.print(Panel.fit(
        "[bold green]Full EC2 Workflow[/bold green]\n"
        f"Course ID: [cyan]{course_id}[/cyan]\n"
        f"Launch Template: [yellow]{launch_template}[/yellow]",
        title="🚀 Run All",
    ))

    _cid = course_id
    _lt = launch_template
    steps: list[tuple[str, object]] = [
        ("Launch VMs", lambda: launch_vms(course_id=_cid, launch_template=_lt)),
        ("Share Keys", lambda: share_keys(course_id=_cid)),
    ]

    passed = 0
    failed = 0
    step_results: list[tuple[str, str]] = []

    for name, step_fn in steps:
        console.rule(f"[bold cyan]{name}[/bold cyan]")
        console.print()

        try:
            step_fn()  # type: ignore[operator]
            step_results.append((name, "passed"))
            passed += 1
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else (1 if e.code else 0)
            if code != 0:
                step_results.append((name, "failed"))
                failed += 1
                console.print(f"\n[red]Step '{name}' failed — aborting remaining steps.[/red]")
                break
            else:
                step_results.append((name, "passed"))
                passed += 1
        except Exception as e:
            step_results.append((name, f"error: {e}"))
            failed += 1
            console.print(f"\n[red]Step '{name}' failed — aborting remaining steps.[/red]")
            break

        console.print()

    # Summary
    console.rule("[bold]Summary[/bold]")
    lines: list[str] = []
    for name, status in step_results:
        if status == "passed":
            lines.append(f"  [green]✓[/green] {name}")
        else:
            lines.append(f"  [red]✗[/red] {name} — {status}")

    console.print(Panel.fit(
        "\n".join(lines) + "\n\n"
        f"[green]✓ Passed:[/green] {passed} | "
        f"[red]✗ Failed:[/red] {failed}",
        title="📊 Run All Summary",
        border_style="green" if failed == 0 else "red",
    ))

    if failed > 0:
        raise typer.Exit(1)


@ec2_app.command("terminate", rich_help_panel="Workflow")
def terminate_vms(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
):
    """Terminate all EC2 instances for a course."""
    init()
    from edutools.ec2 import EC2Provisioner, terminate_student_vms

    if course_id is None:
        course_id = _select_course()

    # Show what will be terminated before asking for confirmation
    ec2 = EC2Provisioner()
    instances = ec2.find_course_instances(course_id)

    if not instances:
        console.print(f"[yellow]No running instances found for course {course_id}.[/yellow]")
        return

    table = Table(title=f"Instances for Course {course_id}", show_header=True, header_style="bold magenta")
    table.add_column("Instance ID", style="cyan")
    table.add_column("Student", style="green")
    table.add_column("State", style="yellow")
    table.add_column("Public IP", style="yellow")

    for inst in instances:
        table.add_row(
            inst["instance_id"],
            inst["student"] or "[dim]N/A[/dim]",
            inst["state"],
            inst["public_ip"] or "[dim]N/A[/dim]",
        )

    console.print(table)
    console.print()

    if not confirm:
        confirm = typer.confirm(
            f"This will TERMINATE {len(instances)} instance(s) for course {course_id}. Continue?"
        )
        if not confirm:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=None)
        results = terminate_student_vms(
            course_id,
            progress_callback=_rich_progress_callback(progress, task),
        )

    if not results:
        console.print("[yellow]No instances were terminated.[/yellow]")
        return

    result_table = Table(title="🗑️ Termination Results", show_header=True, header_style="bold magenta")
    result_table.add_column("Instance ID", style="cyan")
    result_table.add_column("Student", style="green")
    result_table.add_column("Status", justify="center")

    for r in results:
        status = r["status"]
        if status == "terminated":
            status_display = "[green]✓ terminated[/green]"
        else:
            status_display = f"[red]✗ {status}[/red]"
        result_table.add_row(r["instance_id"], r["student"] or "[dim]N/A[/dim]", status_display)

    console.print(result_table)

    terminated = sum(1 for r in results if r["status"] == "terminated")
    errors = len(results) - terminated

    console.print()
    console.print(Panel.fit(
        f"[bold]Total:[/bold] {len(results)} | "
        f"[green]✓ Terminated:[/green] {terminated} | "
        f"[red]✗ Errors:[/red] {errors}",
        title="📊 Summary",
    ))


# ============================================================================
# Google Commands
# ============================================================================

@google_app.command("create-doc", no_args_is_help=True, rich_help_panel="Workflow")
def create_doc(
    title: str = typer.Argument(..., help="Document title"),
    folder_id: Optional[str] = typer.Argument(None, help="Optional Google Drive folder ID"),
):
    """Create a new Google Doc."""
    init()
    import edutools.google as google_helpers

    with console.status("[bold green]Creating Google Doc...", spinner="dots"):
        doc_id = google_helpers.create_doc(title, folder_id)

    console.print(Panel.fit(
        f"[bold green]Document Created![/bold green]\n\n"
        f"Title: [cyan]{title}[/cyan]\n"
        f"Document ID: [yellow]{doc_id}[/yellow]\n"
        f"URL: [link=https://docs.google.com/document/d/{doc_id}]https://docs.google.com/document/d/{doc_id}[/link]",
        title="📄 Google Docs",
    ))


@google_app.command("check", rich_help_panel="Checks")
def google_check(
    test_email: Optional[str] = typer.Option(
        None, "--email", "-e",
        help="Email to share the test folder with (optional)",
    ),
):
    """Verify Google Drive, Docs, and Gmail APIs.

    Creates a test folder, Google Doc, and file upload, optionally
    shares with a test email.  Use [cyan]google check-cleanup[/cyan] to remove afterwards.
    """
    init()
    import edutools.google as google_helpers

    console.print(Panel.fit(
        "[bold green]Google API Check[/bold green]\n"
        + (f"Test email: [cyan]{test_email}[/cyan]\n" if test_email else "")
        + "[dim]Will create a test folder, doc, and file.\n"
          "Use 'google check-cleanup' to remove afterwards.[/dim]",
        title="📄 Google",
    ))

    folder_id = ""
    steps_passed = 0
    total_steps = 4 if test_email else 3
    status = "error"
    error_detail = ""

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Starting...", total=total_steps)

        try:
            # Step 1: Create folder
            progress.update(task, completed=1, description="[cyan]Creating test folder...")
            folder_id = google_helpers.create_folder("edutools-google-check")
            steps_passed += 1

            # Step 2: Create Google Doc
            progress.update(task, completed=2, description="[cyan]Creating Google Doc...")
            google_helpers.create_doc_with_content(
                "Test Document", "Hello from edutools check!\n", folder_id=folder_id,
            )
            steps_passed += 1

            # Step 3: Upload test file
            progress.update(task, completed=3, description="[cyan]Uploading test file...")
            google_helpers.upload_text_file("test.txt", "edutools check file\n", folder_id)
            steps_passed += 1

            # Step 4: Share (if email provided)
            if test_email:
                progress.update(task, completed=4, description=f"[cyan]Sharing with {test_email}...")
                google_helpers.share_with_user(folder_id, test_email)
                steps_passed += 1

            status = "passed"

        except Exception as e:
            error_detail = str(e)

    passed = status == "passed"
    border = "green" if passed else "red"
    status_icon = "[green]✓ PASSED[/green]" if passed else "[red]✗ FAILED[/red]"

    lines = [
        f"Status: {status_icon}",
        "",
        f"Steps completed: [cyan]{steps_passed}/{total_steps}[/cyan]",
    ]
    if test_email:
        lines.append(f"Shared with:    [cyan]{test_email}[/cyan]")
    if error_detail:
        lines += ["", f"Error: [red]{error_detail}[/red]"]

    lines.append("\n[yellow]Test folder left in Drive — run 'edutools google check-cleanup' to remove.[/yellow]")

    console.print(Panel.fit(
        "\n".join(lines),
        title="🔍 Google Check Results",
        border_style=border,
    ))

    if not passed:
        raise typer.Exit(1)


@google_app.command("check-cleanup", rich_help_panel="Checks")
def google_check_cleanup(
    confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
):
    """Delete test folders from [cyan]google check[/cyan] and [cyan]ec2 check-email[/cyan]."""
    init()
    import edutools.google as google_helpers

    folders = google_helpers.find_files_by_name(
        "edutools-google-check",
        mime_type="application/vnd.google-apps.folder",
    )
    folders += google_helpers.find_files_by_prefix(
        "edutools-check-",
        mime_type="application/vnd.google-apps.folder",
    )

    if not folders:
        console.print("[yellow]No Google check folders found.[/yellow]")
        return

    table = Table(title="Google Check Folders", show_header=True, header_style="bold magenta")
    table.add_column("Folder ID", style="cyan")
    table.add_column("Name", style="green")

    for folder in folders:
        table.add_row(folder["id"], folder["name"])

    console.print(table)
    console.print()

    if not confirm:
        confirm = typer.confirm(f"Delete {len(folders)} check folder(s)?")
        if not confirm:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit()

    deleted = 0
    errors = 0
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Deleting...", total=len(folders))
        for i, folder in enumerate(folders, 1):
            progress.update(task, completed=i, description=f"[cyan]Deleting {folder['id']}...")
            try:
                google_helpers.delete_file(folder["id"])
                deleted += 1
            except Exception:
                errors += 1

    console.print()
    console.print(Panel.fit(
        f"[green]✓ Deleted:[/green] {deleted}"
        + (f" | [red]✗ Errors:[/red] {errors}" if errors else ""),
        title="🧹 Cleanup Summary",
    ))


# ============================================================================
# Main Entry Point
# ============================================================================

@app.callback(invoke_without_command=True)
def main(ctx: typer.Context):
    """
    🎓 [bold green]Edu Tools[/bold green] - Educational Technology CLI

    Manage Canvas LMS, AWS IAM users, and Google Docs from the command line.

    [dim]Use --help with any command for more information.[/dim]
    """
    init()
    if ctx.invoked_subcommand is None:
        console.print(Panel.fit(
            "[bold green]🎓 Edu Tools CLI[/bold green]\n\n"
            "Available command groups:\n\n"
            "  [cyan]canvas[/cyan]   - Canvas LMS operations (courses, students, assignments)\n"
            "  [cyan]iam[/cyan]      - AWS IAM user management (provision, deprovision, reset)\n"
            "  [cyan]ec2[/cyan]      - AWS EC2 instance management (launch VMs for students)\n"
            "  [cyan]google[/cyan]   - Google Docs operations\n\n"
            "  [cyan]check[/cyan]    - Test all configured service credentials\n\n"
            "[dim]Run 'edutools <command> --help' for more information.[/dim]",
            title="Welcome",
            border_style="green",
        ))


if __name__ == "__main__":
    app()
