import json as _json
import os
import re
import tomllib
import typer
from typing import Any, Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from edutools import full_version

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "edutools")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.toml")

DEFAULT_ENDPOINT = "https://boisestatecanvas.instructure.com"

_DEFAULT_CONFIG = f"""\
# Edutools Configuration
# Run 'edutools check' to verify your credentials after editing.

[canvas]
# API access token (required)
# Generate at: Canvas -> Account -> Settings -> Approved Integrations -> + New Access Token
token = ""
# Canvas instance URL (optional, defaults to {DEFAULT_ENDPOINT})
# endpoint = "{DEFAULT_ENDPOINT}"
"""

app = typer.Typer(
    name="edutools",
    help="🎓 Canvas LMS CLI - courses, students, assignments, and course publishing",
    add_completion=False,
    rich_markup_mode="rich",
    no_args_is_help=True,
)

console = Console()


# ============================================================================
# Configuration
# ============================================================================

def _check_config() -> bool:
    """Report whether a Canvas token is available."""
    return bool(os.getenv("CANVAS_TOKEN"))


def _show_setup_status(has_canvas: bool) -> None:
    """Display Canvas configuration status, with setup steps when missing."""
    lines: list[str] = [f"Config file: [cyan]{CONFIG_FILE}[/cyan]\n"]

    if has_canvas:
        lines.append("[green]✓[/green] [bold magenta]Canvas LMS[/bold magenta] - configured")
    else:
        lines.append("[red]✗[/red] [bold magenta]Canvas LMS[/bold magenta] - not configured")
        lines.append(f"  Edit [cyan]{CONFIG_FILE}[/cyan] [canvas] section:")
        lines.append("  [yellow]token[/yellow]    - API access token (required)")
        lines.append("              Generate at: Canvas -> Account -> Settings")
        lines.append("              -> Approved Integrations -> + New Access Token")
        lines.append("  [yellow]endpoint[/yellow] - Canvas URL (optional)")
        lines.append(f"              Defaults to {DEFAULT_ENDPOINT}")

    lines.append("")
    lines.append("[dim]Run 'edutools check' to verify credentials work.[/dim]")

    console.print(Panel.fit("\n".join(lines), title="Setup Status", border_style="yellow"))


def _load_config() -> dict[str, dict[str, str]]:
    """Read config.toml and export Canvas settings to the environment.

    Config file values take precedence over existing environment variables.
    """
    if not os.path.exists(CONFIG_FILE):
        return {}

    with open(CONFIG_FILE, "rb") as f:
        config = tomllib.load(f)

    canvas = config.get("canvas", {})
    if canvas.get("token"):
        os.environ["CANVAS_TOKEN"] = canvas["token"]
    if canvas.get("endpoint"):
        os.environ["CANVAS_ENDPOINT"] = canvas["endpoint"]

    return config


def init():
    """Initialize environment and ensure the config directory exists."""
    os.makedirs(CONFIG_DIR, exist_ok=True)

    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            f.write(_DEFAULT_CONFIG)

    _load_config()
    if not _check_config():
        _show_setup_status(False)


def _emit_json(payload: Any) -> None:
    """Print the raw Canvas payload so a caller can parse it instead of a table."""
    console.print_json(_json.dumps(payload, default=str))


# ============================================================================
# Setup and Credential Commands
# ============================================================================

@app.command("init")
def init_config():
    """Create ~/.config/edutools/config.toml and show setup status."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            f.write(_DEFAULT_CONFIG)
        console.print(f"[green]✓[/green] created [cyan]{CONFIG_FILE}[/cyan]")
    else:
        console.print(f"[dim]config already exists at[/dim] [cyan]{CONFIG_FILE}[/cyan]")

    _load_config()
    _show_setup_status(_check_config())


@app.command("check")
def check_credentials():
    """Test the configured Canvas credentials."""
    init()

    endpoint = os.getenv("CANVAS_ENDPOINT", DEFAULT_ENDPOINT)
    token = os.getenv("CANVAS_TOKEN")

    if not token:
        console.print(Panel.fit(
            f"[yellow]⊘[/yellow] [bold]Canvas LMS[/bold] - token not set in "
            f"[cyan]{CONFIG_FILE}[/cyan] [canvas] section",
            title="Credential Check",
            border_style="yellow",
        ))
        raise typer.Exit(1)

    try:
        from edutools.canvas import CanvasLMS

        with console.status("[bold green]Testing Canvas...", spinner="dots"):
            courses = CanvasLMS().get_courses()
    except (Exception, SystemExit) as e:
        console.print(Panel.fit(
            f"[red]✗[/red] [bold]Canvas LMS[/bold] - {endpoint}\n"
            f"  [red]Error:[/red] {e}",
            title="Credential Check",
            border_style="red",
        ))
        raise typer.Exit(1)

    console.print(Panel.fit(
        f"[green]✓[/green] [bold]Canvas LMS[/bold] - {endpoint} ({len(courses)} courses)",
        title="Credential Check",
        border_style="green",
    ))


# ============================================================================
# Interactive Selection Helpers
# ============================================================================

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


# ============================================================================
# Canvas Read Commands
#
# Each accepts --json, which emits the raw Canvas payload instead of a table so
# the output can be parsed rather than scraped.
# ============================================================================

@app.command("courses")
def list_courses(
    all_courses: bool = typer.Option(False, "--all", "-a", help="Show all courses, including past/completed ones"),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table"),
):
    """List courses where you are a teacher."""
    init()
    from edutools.canvas import CanvasLMS

    label = "all" if all_courses else "active"
    with console.status(f"[bold green]Fetching {label} courses from Canvas...", spinner="dots"):
        canvas = CanvasLMS()
        courses = canvas.get_courses(include_all=all_courses)

    if as_json:
        _emit_json(courses)
        return

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


@app.command("assignments")
def list_assignments(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table"),
):
    """List all assignments for a course."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()

    with console.status(f"[bold green]Fetching assignments for course {course_id}...", spinner="dots"):
        canvas = CanvasLMS()
        assignments = canvas.get_assignments(course_id)

    if as_json:
        _emit_json(assignments)
        return

    if not assignments:
        console.print("[yellow]No assignments found.[/yellow]")
        return

    table = Table(title=f"📝 Assignments for Course {course_id}", show_header=True, header_style="bold magenta")
    table.add_column("ID", style="cyan", justify="right")
    table.add_column("Assignment Name", style="green")

    for a in assignments:
        table.add_row(str(a["id"]), str(a["name"]))

    console.print(table)
    console.print(f"\n[dim]Total: {len(assignments)} assignments[/dim]")


@app.command("students")
def list_students(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table"),
):
    """List all students in a course."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()

    with console.status(f"[bold green]Fetching students for course {course_id}...", spinner="dots"):
        canvas = CanvasLMS()
        students = canvas.get_students(course_id)

    if as_json:
        _emit_json(students)
        return

    if not students:
        console.print("[yellow]No students found.[/yellow]")
        return

    table = Table(title=f"👥 Students in Course {course_id}", show_header=True, header_style="bold magenta")
    table.add_column("ID", style="cyan", justify="right")
    table.add_column("Email", style="green")

    for s in students:
        table.add_row(str(s["id"]), str(s.get("email") or "[dim]No email[/dim]"))

    console.print(table)
    console.print(f"\n[dim]Total: {len(students)} students[/dim]")


@app.command("submissions")
def list_submissions(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    assignment_id: Optional[str] = typer.Argument(None, help="Assignment ID (prompted if omitted)"),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table"),
):
    """List all submissions for an assignment."""
    init()
    from edutools.canvas import CanvasLMS

    if course_id is None:
        course_id = _select_course()
    if assignment_id is None:
        assignment_id = _select_assignment(course_id)

    with console.status("[bold green]Fetching submissions...", spinner="dots"):
        canvas = CanvasLMS()
        submissions = canvas.get_submissions(course_id, assignment_id)

    if as_json:
        _emit_json(submissions)
        return

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


@app.command("ungraded")
def list_ungraded(
    course_id: Optional[str] = typer.Argument(None, help="Canvas course ID (prompted if omitted)"),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table"),
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

    if as_json:
        _emit_json(ungraded)
        return

    if not ungraded:
        console.print("[green]All submissions have been graded.[/green]")
        return

    table = Table(
        title=f"Ungraded Submissions - Course {course_id}",
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
# Course Publishing Commands
# ============================================================================

@app.command("push")
def push_course(
    repo: str = typer.Argument(..., help="Course repository containing canvas.toml"),
    course_id: str = typer.Option(..., "--course", help="Canvas course ID"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Render everything, write nothing"),
    publish: bool = typer.Option(False, "--publish", help="Make objects student-visible (default: unpublished)"),
    only: Optional[list[str]] = typer.Option(None, "--only", help="Limit to: pages, assignments, discussions, quizzes, files, modules, syllabus, rubrics"),
    verify: bool = typer.Option(True, "--verify/--no-verify", help="Read everything back from Canvas afterwards"),
    preview: Optional[str] = typer.Option(None, "--preview", help="Write the rendered HTML to a directory and open nothing else"),
):
    """Publish a course repository to Canvas.

    Two passes: create or update every object, then rewrite relative links now
    that ids exist. Everything is created UNPUBLISHED unless --publish is given.
    """
    from pathlib import Path

    from edutools.publish import PublishError
    from edutools.publisher import Publisher

    init()
    repo_path = Path(repo).expanduser()

    canvas = None
    if not dry_run:
        from edutools.canvas import CanvasLMS

        canvas = CanvasLMS()

    try:
        publisher = Publisher(
            repo_path, course_id, canvas, publish=publish, dry_run=dry_run, report=console.print
        )
        plans = publisher.plan()
    except (PublishError, ValueError) as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(1)

    wanted = set(only or [])
    kind_group = {
        "page": "pages", "assignment": "assignments", "discussion": "discussions",
        "quiz": "quizzes", "file": "files", "syllabus": "syllabus",
    }
    selected = [p for p in plans if not wanted or kind_group.get(p.kind) in wanted]

    totals = {"created": 0, "updated": 0, "skipped": 0}
    problems: list[str] = []

    label = "Rendering" if dry_run else "Publishing"
    with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                  BarColumn(), TaskProgressColumn(), console=console) as progress:
        task = progress.add_task(f"{label} {len(selected)} objects", total=len(selected))
        for item in selected:
            progress.update(task, description=f"{label} {item.key}")
            try:
                outcome = publisher.create_or_update(item)
                totals["created"] += outcome.created
                totals["updated"] += outcome.updated
                totals["skipped"] += outcome.skipped
                problems.extend(outcome.errors)
            except (PublishError, RuntimeError) as error:
                problems.append(f"{item.key}: {error}")
            progress.advance(task)

        if not dry_run:
            task = progress.add_task("Rewriting links", total=len(selected))
            for item in selected:
                unresolved = publisher.rewrite(item)
                problems.extend(f"{item.key}: unresolved link {u}" for u in unresolved)
                progress.advance(task)

    if publisher.dropped_css:
        console.print(
            f"[yellow]⚠ {len(publisher.dropped_css)} CSS properties are not on Canvas's "
            f"allowlist and were dropped:[/yellow] {', '.join(sorted(publisher.dropped_css))}"
        )
        problems.append("canvas.css contains properties Canvas will not store")

    if not wanted or "modules" in wanted:
        outcome = publisher.push_modules()
        totals["created"] += outcome.created
        totals["updated"] += outcome.updated
        problems.extend(outcome.errors)

    if "rubrics" in wanted:
        outcome = publisher.push_rubrics()
        totals["created"] += outcome.created
        problems.extend(outcome.errors)

    table = Table(title="📤 Canvas push", show_header=True, header_style="bold magenta")
    table.add_column("Outcome", style="cyan")
    table.add_column("Count", justify="right")
    for name, count in totals.items():
        table.add_row(name, str(count))
    console.print(table)

    if problems:
        console.print(f"\n[red]{len(problems)} problem(s):[/red]")
        for problem in problems[:40]:
            console.print(f"  [red]•[/red] {problem}")
        raise typer.Exit(1)

    if preview:
        preview_dir = Path(preview).expanduser()
        preview_dir.mkdir(parents=True, exist_ok=True)
        written = 0
        for key, html in publisher.rendered.items():
            name = key.replace("/", "__").replace(".md", ".html")
            (preview_dir / name).write_text(
                "<!doctype html><meta charset=utf-8>"
                "<div style='max-width:900px;margin:40px auto;font-family:system-ui'>"
                f"<h1>{key}</h1>{html}</div>",
                encoding="utf-8",
            )
            written += 1
        console.print(f"[green]✓[/green] wrote {written} preview pages to {preview_dir}")

    if dry_run:
        console.print("\n[green]✓[/green] dry run: nothing was written to Canvas.")
        return

    console.print(
        f"\n[green]✓[/green] pushed to course {course_id} "
        f"({'published' if publish else '[bold]unpublished[/bold]'})"
    )
    if verify:
        verify_course(repo, course_id)


@app.command("verify")
def verify_course(
    repo: str = typer.Argument(..., help="Course repository containing canvas.toml"),
    course_id: str = typer.Option(..., "--course", help="Canvas course ID"),
):
    """Read every published object back from Canvas and prove it arrived intact.

    Catches what a 200 response does not: silent sanitiser stripping, partial
    quiz writes, files stuck pending, and drift from someone editing in the
    Canvas UI.
    """
    from pathlib import Path

    from edutools.canvas import CanvasLMS
    from edutools.publisher import Publisher
    from edutools.verify import (
        Failure,
        check_body,
        check_file,
        check_gradebook_total,
        check_identity,
        check_links,
        check_quiz_questions,
        known_link_targets,
        summarise,
    )

    init()
    repo_path = Path(repo).expanduser()
    canvas = CanvasLMS()
    publisher = Publisher(repo_path, course_id, canvas)
    plans = {p.key: p for p in publisher.plan()}
    manifest = publisher.manifest

    if not manifest.entries:
        console.print("[yellow]Nothing in the manifest for this course, push first.[/yellow]")
        raise typer.Exit(1)

    failures: list[Failure] = []
    known = known_link_targets(manifest, course_id)

    def resolves(link: str) -> bool:
        return canvas.exists("/api/v1" + link)

    with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"),
                  BarColumn(), TaskProgressColumn(), console=console) as progress:
        task = progress.add_task("Verifying", total=len(manifest.entries))
        for key, entry in sorted(manifest.entries.items()):
            progress.update(task, description=f"Verifying {key}")
            plan = plans.get(key)
            try:
                if entry.kind == "page":
                    stored = canvas.get_page(course_id, entry.page_url)
                    body = str(stored.get("body") or "")
                elif entry.kind == "assignment":
                    stored = canvas.get_assignment_full(course_id, entry.canvas_id)
                    body = str(stored.get("description") or "")
                elif entry.kind == "discussion":
                    stored = canvas.get_discussion(course_id, entry.canvas_id)
                    body = str(stored.get("message") or "")
                elif entry.kind == "quiz":
                    stored = canvas.get_quiz(course_id, entry.canvas_id)
                    body = str(stored.get("description") or "")
                elif entry.kind == "file":
                    stored = canvas.get_file(entry.canvas_id)
                    body = ""
                else:
                    progress.advance(task)
                    continue
            except RuntimeError:
                failures.extend(check_identity(key, entry, None))
                progress.advance(task)
                continue

            failures.extend(check_identity(key, entry, stored))

            if entry.kind == "file" and plan and plan.source:
                failures.extend(check_file(key, plan.source.stat().st_size, stored))
            elif plan and plan.source:
                try:
                    intended = publisher.rendered.get(key)
                    if intended is None:
                        _, intended = publisher.render(plan.source)
                        rewritten, _ = __import__(
                            "edutools.publish", fromlist=["rewrite_links"]
                        ).rewrite_links(intended, plan.source, publisher.repo, manifest, course_id)
                        intended = rewritten
                    failures.extend(check_body(key, intended, body))
                    failures.extend(check_links(key, body, course_id, known, resolves))
                except Exception as error:  # noqa: BLE001 - report, do not abort the sweep
                    failures.append(Failure(key, "render", str(error)))

            if entry.kind == "quiz" and plan and plan.source:
                from edutools.publish import parse_quiz

                expected = len(parse_quiz(plan.source))
                questions = canvas.list_quiz_questions(course_id, entry.canvas_id)
                failures.extend(check_quiz_questions(key, expected, questions))

            progress.advance(task)

    assignments = canvas.list_json(f"/api/v1/courses/{course_id}/assignments")
    published_assignments = [a for a in assignments if a.get("published")]
    if published_assignments:
        failures.extend(check_gradebook_total(published_assignments, 1000.0))

    if not failures:
        console.print(
            f"\n[green]✓ all {len(manifest.entries)} objects verified against Canvas[/green]"
        )
        return

    table = Table(title="❌ Verification failures", show_header=True, header_style="bold red")
    table.add_column("Object", style="cyan", no_wrap=False)
    table.add_column("Check", style="yellow")
    table.add_column("Detail", no_wrap=False)
    for failure in failures[:60]:
        table.add_row(failure.key, failure.check, failure.detail)
    console.print(table)
    console.print(f"\n[red]{len(failures)} failure(s):[/red] {summarise(failures)}")
    raise typer.Exit(1)


@app.command("dates")
def course_dates(
    repo: str = typer.Argument(..., help="Course repository containing canvas.toml"),
    show: bool = typer.Option(False, "--show", help="Print the generated schedule and exit"),
    shift: Optional[str] = typer.Option(None, "--shift", help="Shift the whole term, e.g. '7d' or '-3d'"),
):
    """Generate every due / available-from / until date for a course.

    Reads the term skeleton and per-type date policies from <repo>/canvas.toml and
    derives the three Canvas date fields for every gradable item. --show needs no
    Canvas token: it prints the whole semester so it can be reviewed before anything
    is written.
    """
    from pathlib import Path

    from edutools.dates import (
        DateConfigError,
        compute,
        cross_check_syllabus,
        load_config,
        validate,
    )

    repo_path = Path(repo).expanduser()
    try:
        config = load_config(repo_path)
        items = compute(repo_path, config)
    except DateConfigError as error:
        console.print(f"[red]Date configuration error:[/red] {error}")
        raise typer.Exit(1)

    if shift:
        match = re.fullmatch(r"(-?\d+)d", shift.strip())
        if not match:
            console.print(f"[red]Bad --shift value {shift!r}; expected something like '7d' or '-3d'.[/red]")
            raise typer.Exit(1)
        days = int(match.group(1))
        items = [item.shifted(days) for item in items]
        console.print(f"[yellow]Showing the term shifted by {days:+d} days.[/yellow]\n")

    table = Table(
        title=f"🗓  {config.term.weeks}-week schedule, {len(items)} gradable items",
        show_header=True,
        header_style="bold magenta",
    )
    table.add_column("Item", style="green", no_wrap=False)
    table.add_column("Type", style="cyan")
    table.add_column("Wk", justify="right")
    table.add_column("Pts", justify="right", style="dim")
    table.add_column("Available from")
    table.add_column("Due", style="bold")
    table.add_column("Until")

    for item in items:
        table.add_row(
            item.title,
            item.kind,
            str(item.week) if item.week is not None else "-",
            f"{item.points:g}",
            item.unlock_at.strftime("%b %d %H:%M"),
            item.due_at.strftime("%b %d %H:%M"),
            item.lock_at.strftime("%b %d %H:%M"),
        )
    console.print(table)

    problems = validate(items, config.term)
    syllabus = repo_path / "syllabus.md"
    if syllabus.exists():
        problems += cross_check_syllabus(syllabus, config.term)

    if problems:
        console.print(f"\n[red]{len(problems)} problem(s):[/red]")
        for problem in problems:
            console.print(f"  [red]•[/red] {problem}")
        raise typer.Exit(1)

    total = sum(item.points for item in items)
    console.print(
        f"\n[green]✓[/green] {len(items)} items · [bold]{total:g} points[/bold] · "
        f"dates consistent with the syllabus schedule"
    )
    if not show:
        console.print(
            "[dim]--show only prints. Writing dates to Canvas arrives with "
            "'edutools push'.[/dim]"
        )


# ============================================================================
# Main Entry Point
# ============================================================================

def _version_callback(value: bool) -> None:
    """Print the version and exit when --version is passed."""
    if value:
        console.print(f"edutools [cyan]{full_version()}[/cyan]")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show the edutools version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
):
    """
    🎓 [bold green]Edu Tools[/bold green] - Canvas LMS from the command line

    Query courses, students, assignments, and submissions, and publish a course
    repository into Canvas.

    [dim]Use --help with any command for more information.[/dim]
    """


if __name__ == "__main__":
    app()
