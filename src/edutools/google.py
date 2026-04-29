from __future__ import annotations

import base64
import os.path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import List, Dict, Any, Optional

from google.auth.transport.requests import Request
from google.auth.credentials import Credentials
from google.oauth2.credentials import Credentials as OAuthCredentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# Scopes for Docs and Drive
DOCS_SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
]

# Scopes for Gmail
GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
]

# Combined scopes (for single token file)
ALL_SCOPES = DOCS_SCOPES + GMAIL_SCOPES

# For backwards compatibility
SCOPES = DOCS_SCOPES


def _config_dir() -> str:
    """Return the config directory, creating it if needed."""
    config = os.path.join(os.path.expanduser("~"), ".config", "edutools")
    os.makedirs(config, exist_ok=True)
    return config


def _get_oauth_path() -> str:
    """Resolve the OAuth client secrets file path."""
    path = os.getenv("GOOGLE_OAUTH_PATH")
    if path and os.path.exists(path):
        return path
    default = os.path.join(_config_dir(), "client_secret.json")
    if os.path.exists(default):
        return default
    raise ValueError(
        "Google OAuth client secrets not found. Either set GOOGLE_OAUTH_PATH "
        "or place client_secret.json in ~/.config/edutools/"
    )


def _get_credentials() -> Credentials:
    GOOGLE_TOKEN_PATH = os.path.join(_config_dir(), "google_token.json")
    GOOGLE_OAUTH_PATH = _get_oauth_path()

    creds: Optional[Credentials] = None
    if os.path.exists(GOOGLE_TOKEN_PATH):
        creds = OAuthCredentials.from_authorized_user_file(GOOGLE_TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(GOOGLE_OAUTH_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(GOOGLE_TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    if not creds:
        raise ValueError("Failed to obtain credentials.")
    return creds


def _docs_service():
    creds = _get_credentials()
    return build("docs", "v1", credentials=creds)


def _drive_service():
    creds = _get_credentials()
    return build("drive", "v3", credentials=creds)


def create_doc(title: str, folder_id: Optional[str] = None) -> str:
    """
    Create a Google Doc and optionally place it in a folder.

    Args:
        title: Document title
        folder_id: Optional Google Drive folder ID to place the document in

    Returns:
        The document ID
    """
    service = _docs_service()
    body = {"title": title}

    doc = service.documents().create(body=body).execute()
    doc_id = doc["documentId"]

    # Move to folder if specified
    if folder_id:
        drive = _drive_service()
        drive.files().update(
            fileId=doc_id, addParents=folder_id, fields="id, parents"
        ).execute()

    return doc_id


def insert_text(document_id: str, text: str, index: int = 1) -> None:
    """
    Insert text at a given character index.
    Index 1 is usually right after the start of the document body.
    """
    service = _docs_service()
    requests: List[Dict[str, Any]] = [
        {
            "insertText": {
                "location": {"index": index},
                "text": text,
            }
        }
    ]
    service.documents().batchUpdate(
        documentId=document_id, body={"requests": requests}
    ).execute()


def replace_all_text(
    document_id: str, old: str, new: str, match_case: bool = True
) -> int:
    service = _docs_service()
    requests: List[Dict[str, Any]] = [
        {
            "replaceAllText": {
                "containsText": {"text": old, "matchCase": match_case},
                "replaceText": new,
            }
        }
    ]
    resp = (
        service.documents()
        .batchUpdate(documentId=document_id, body={"requests": requests})
        .execute()
    )
    # replies may be empty; replaceAllText returns an empty reply in many cases
    # so we just return 0 if we can't infer counts.
    return 0


# ============================================================================
# Drive Functions
# ============================================================================


def create_folder(name: str, parent_id: Optional[str] = None) -> str:
    """Create a Google Drive folder.

    Args:
        name: Folder name.
        parent_id: Optional parent folder ID.  If omitted the folder is
            created in the caller's Drive root.

    Returns:
        The folder ID.
    """
    drive = _drive_service()
    metadata: Dict[str, Any] = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        metadata["parents"] = [parent_id]
    folder: Dict[str, Any] = drive.files().create(body=metadata, fields="id").execute()
    folder_id: str = folder["id"]
    return folder_id


def create_doc_with_content(
    title: str, content: str, folder_id: Optional[str] = None,
) -> str:
    """Create a Google Doc pre-populated with text content.

    Uses Drive file upload with conversion so the document is immediately
    ready when opened — avoids the propagation delay caused by creating an
    empty doc then inserting text via a separate ``batchUpdate`` call.

    Args:
        title: Document title.
        content: Plain-text content for the document body.
        folder_id: Optional Google Drive folder ID to place the document in.

    Returns:
        The document ID.
    """
    from googleapiclient.http import MediaInMemoryUpload

    drive = _drive_service()
    media = MediaInMemoryUpload(
        content.encode("utf-8"),
        mimetype="text/plain",
        resumable=False,
    )
    metadata: Dict[str, Any] = {
        "name": title,
        "mimeType": "application/vnd.google-apps.document",
    }
    if folder_id:
        metadata["parents"] = [folder_id]
    result: Dict[str, Any] = drive.files().create(
        body=metadata, media_body=media, fields="id",
    ).execute()
    doc_id: str = result["id"]
    return doc_id


def upload_text_file(name: str, content: str, folder_id: str) -> str:
    """Upload a plain-text file to Google Drive.

    The file is stored as a binary blob (not converted to a Google Doc)
    so students can download the original content.

    Args:
        name: Filename (e.g. ``jdoe-sshkey``).
        content: File content as a string.
        folder_id: Google Drive folder ID to upload into.

    Returns:
        The file ID.
    """
    from googleapiclient.http import MediaInMemoryUpload

    drive = _drive_service()
    media = MediaInMemoryUpload(
        content.encode("utf-8"),
        mimetype="text/plain",
        resumable=False,
    )
    metadata: Dict[str, Any] = {
        "name": name,
        "parents": [folder_id],
    }
    result: Dict[str, Any] = drive.files().create(
        body=metadata, media_body=media, fields="id",
    ).execute()
    file_id: str = result["id"]
    return file_id


def share_with_user(file_id: str, email: str, role: str = "reader") -> str:
    """Share a Drive file or folder with a user.

    Creates a permission on *file_id* granting *role* to *email*.
    Google sends a default notification email to the recipient.

    Args:
        file_id: Google Drive file or folder ID.
        email: Email address of the user to share with.
        role: Permission role (``reader``, ``writer``, ``commenter``).

    Returns:
        The permission ID.
    """
    drive = _drive_service()
    permission: Dict[str, str] = {
        "type": "user",
        "role": role,
        "emailAddress": email,
    }
    result: Dict[str, Any] = drive.permissions().create(
        fileId=file_id,
        body=permission,
        fields="id",
        sendNotificationEmail=True,
    ).execute()
    perm_id: str = result["id"]
    return perm_id


def find_files_by_name(name: str, mime_type: Optional[str] = None) -> list[Dict[str, str]]:
    """Find Drive files whose name exactly matches *name*.

    Args:
        name: Exact file/folder name to search for.
        mime_type: Optional MIME type filter (e.g.
            ``application/vnd.google-apps.folder`` to match only folders).

    Returns:
        List of dicts with keys: id, name.
    """
    drive = _drive_service()
    q = f"name = '{name}' and trashed = false"
    if mime_type:
        q += f" and mimeType = '{mime_type}'"
    resp: Dict[str, Any] = drive.files().list(q=q, fields="files(id, name)").execute()
    files: list[Dict[str, str]] = [
        {"id": f["id"], "name": f["name"]}
        for f in resp.get("files", [])
    ]
    return files


def find_files_by_prefix(
    prefix: str, mime_type: Optional[str] = None,
) -> list[Dict[str, str]]:
    """Find Drive files whose name starts with *prefix*.

    Uses the ``name contains`` query operator and then filters client-side
    to ensure the match is a true prefix.

    Args:
        prefix: Name prefix to search for.
        mime_type: Optional MIME type filter.

    Returns:
        List of dicts with keys: id, name.
    """
    drive = _drive_service()
    q = f"name contains '{prefix}' and trashed = false"
    if mime_type:
        q += f" and mimeType = '{mime_type}'"
    resp: Dict[str, Any] = drive.files().list(q=q, fields="files(id, name)").execute()
    files: list[Dict[str, str]] = [
        {"id": f["id"], "name": f["name"]}
        for f in resp.get("files", [])
        if f["name"].startswith(prefix)
    ]
    return files


def delete_file(file_id: str) -> None:
    """Delete a file or folder from Google Drive.

    When a folder is deleted its contents are also removed.

    Args:
        file_id: Google Drive file or folder ID to delete.
    """
    drive = _drive_service()
    drive.files().delete(fileId=file_id).execute()


def list_folder_contents(folder_id: str) -> list[Dict[str, str]]:
    """List all files and folders inside a Drive folder.

    Args:
        folder_id: Google Drive folder ID.

    Returns:
        List of dicts with keys: id, name, mimeType.
    """
    drive = _drive_service()
    q = f"'{folder_id}' in parents and trashed = false"
    resp: Dict[str, Any] = drive.files().list(
        q=q, fields="files(id, name, mimeType)",
    ).execute()
    files: list[Dict[str, str]] = [
        {"id": f["id"], "name": f["name"], "mimeType": f["mimeType"]}
        for f in resp.get("files", [])
    ]
    return files


def download_text_file(file_id: str) -> str:
    """Download the content of a plain-text file from Google Drive.

    Args:
        file_id: Google Drive file ID.

    Returns:
        File content as a string.
    """
    drive = _drive_service()
    # get_media returns the raw file bytes for non-Google-Docs files.
    # The drive.file scope is sufficient because the app created these files.
    content: bytes = drive.files().get_media(fileId=file_id).execute()
    return content.decode("utf-8")


# ============================================================================
# Gmail Functions
# ============================================================================

def _get_gmail_credentials() -> Credentials:
    """Get credentials with Gmail scope."""
    GOOGLE_OAUTH_PATH = _get_oauth_path()

    # Use a separate token file for Gmail to avoid scope conflicts
    gmail_token_path = os.path.join(_config_dir(), "google_token_gmail.json")

    creds: Optional[Credentials] = None
    if os.path.exists(gmail_token_path):
        creds = OAuthCredentials.from_authorized_user_file(gmail_token_path, GMAIL_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(GOOGLE_OAUTH_PATH, GMAIL_SCOPES)
            creds = flow.run_local_server(port=0)

        with open(gmail_token_path, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    if not creds:
        raise ValueError("Failed to obtain Gmail credentials.")
    return creds


def _gmail_service():
    """Get Gmail API service."""
    creds = _get_gmail_credentials()
    return build("gmail", "v1", credentials=creds)


def send_email(
    to: str,
    subject: str,
    body_text: str,
    body_html: Optional[str] = None,
    sender: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send an email using Gmail API.

    Args:
        to: Recipient email address
        subject: Email subject
        body_text: Plain text body
        body_html: Optional HTML body
        sender: Optional sender address (defaults to authenticated user)

    Returns:
        Gmail API response dict with message id
    """
    service = _gmail_service()

    if body_html:
        message = MIMEMultipart("alternative")
        message.attach(MIMEText(body_text, "plain"))
        message.attach(MIMEText(body_html, "html"))
    else:
        message = MIMEText(body_text, "plain")

    message["to"] = to
    message["subject"] = subject
    if sender:
        message["from"] = sender

    # Encode the message
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")

    try:
        result = service.users().messages().send(
            userId="me",
            body={"raw": raw}
        ).execute()
        return {"success": True, "message_id": result.get("id"), "error": None}
    except Exception as e:
        return {"success": False, "message_id": None, "error": str(e)}
