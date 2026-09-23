import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AppInfo, SiteView } from "../../../shared/ipc";
import { messageOf, type ScreenProps } from "./types";

type Outcome = { readonly kind: "ok" | "error" | "info"; readonly text: string } | null;

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (!outcome) {
    return null;
  }
  return (
    <p className={`message ${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
      {outcome.text}
    </p>
  );
}

export function Settings({ setStatus }: ScreenProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [sites, setSites] = useState<SiteView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [siteOutcome, setSiteOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [addOutcome, setAddOutcome] = useState<Outcome>(null);

  const [newToken, setNewToken] = useState("");
  const [importOutcome, setImportOutcome] = useState<Outcome>(null);

  const refresh = useCallback(async () => {
    try {
      const [appInfo, list] = await Promise.all([window.edutools.appInfo(), window.edutools.listSites()]);
      setInfo(appInfo);
      setEndpoint((current) => current || appInfo.defaultEndpoint);
      setSites(list);
    } catch (error) {
      setSiteOutcome({ kind: "error", text: messageOf(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = sites.find((s) => s.name === selected) ?? null;

  /** Run one action with the buttons disabled, reporting its result in `report`. */
  const run = async (report: (o: Outcome) => void, action: () => Promise<string>) => {
    setBusy(true);
    report({ kind: "info", text: "Working..." });
    try {
      const text = await action();
      report({ kind: "ok", text });
      setStatus(text);
    } catch (error) {
      report({ kind: "error", text: messageOf(error) });
      setStatus("Settings: the last action failed");
    } finally {
      setBusy(false);
    }
  };

  const testSaved = () =>
    current &&
    run(setSiteOutcome, async () => {
      const result = await window.edutools.testSite(current.name);
      return `Connected to ${result.endpoint}: ${result.courseCount} active courses.`;
    });

  const makeDefault = () =>
    current &&
    run(setSiteOutcome, async () => {
      setSites(await window.edutools.setDefaultSite(current.name));
      return `${current.name} is now the default site.`;
    });

  const remove = () => {
    if (!current) {
      return;
    }
    const ok = window.confirm(
      `Remove the site "${current.name}"?\n\nIts access token is deleted from this computer's keychain. The token itself still works in Canvas until you delete it there.`,
    );
    if (ok) {
      void run(setSiteOutcome, async () => {
        setSites(await window.edutools.removeSite(current.name));
        setSelected(null);
        return `Removed ${current.name}.`;
      });
    }
  };

  const replaceToken = (event: FormEvent) => {
    event.preventDefault();
    if (!current) {
      return;
    }
    void run(setSiteOutcome, async () => {
      setSites(await window.edutools.setToken(current.name, newToken));
      setNewToken("");
      return `Saved a new token for ${current.name}.`;
    });
  };

  const testNew = () =>
    run(setAddOutcome, async () => {
      const result = await window.edutools.testConnection({ endpoint, token });
      return `Connected to ${result.endpoint}: ${result.courseCount} active courses.`;
    });

  const addNew = (event: FormEvent) => {
    event.preventDefault();
    void run(setAddOutcome, async () => {
      const list = await window.edutools.addSite({ name, endpoint, token });
      setSites(list);
      setName("");
      setToken("");
      return "Site added. The token is saved in this computer's keychain.";
    });
  };

  const importLegacy = () =>
    run(setImportOutcome, async () => {
      const result = await window.edutools.importLegacyConfig();
      await refresh();
      if (!result.imported) {
        return `Nothing to import: no token found in ${result.path}.`;
      }
      return result.created
        ? `Imported the token as a new site, "${result.siteName}".`
        : `Updated the token for "${result.siteName}".`;
    });

  return (
    <div className="stack">
      <fieldset className="group">
        <legend>Canvas sites</legend>
        <div className="table-frame short">
          <table className="grid selectable">
            <thead>
              <tr>
                <th className="narrow">Default</th>
                <th>Name</th>
                <th>Canvas address</th>
                <th>Token</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr key={site.name} className={site.name === selected ? "selected" : undefined}>
                  <td className="narrow">
                    <input
                      type="radio"
                      name="site"
                      aria-label={`Select ${site.name}`}
                      checked={site.name === selected}
                      onChange={() => setSelected(site.name)}
                    />
                    {site.isDefault ? " Yes" : ""}
                  </td>
                  <td>{site.name}</td>
                  <td>{site.endpoint}</td>
                  <td className="mono">{site.tokenHint ?? "(none saved)"}</td>
                </tr>
              ))}
              {sites.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No sites yet. Add one below, or import from an earlier edutools.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="buttons">
          <button type="button" disabled={!current || busy} onClick={() => void testSaved()}>
            Test
          </button>
          <button type="button" disabled={!current || current.isDefault || busy} onClick={() => void makeDefault()}>
            Set as Default
          </button>
          <button type="button" disabled={!current || busy} onClick={remove}>
            Remove...
          </button>
        </div>
        {current && (
          <form className="form-row" onSubmit={replaceToken}>
            <label htmlFor="replace-token">New token for {current.name}:</label>
            <input
              id="replace-token"
              type="password"
              autoComplete="off"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
            />
            <button type="submit" disabled={!newToken.trim() || busy}>
              Replace Token
            </button>
          </form>
        )}
        <OutcomeLine outcome={siteOutcome} />
      </fieldset>

      <fieldset className="group">
        <legend>Add a site</legend>
        <form className="form-grid" onSubmit={addNew}>
          <label htmlFor="site-name">Name:</label>
          <input
            id="site-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Boise State (optional; defaults to the address)"
          />
          <label htmlFor="site-endpoint">Canvas address:</label>
          <input id="site-endpoint" type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          <label htmlFor="site-token">Access token:</label>
          <input
            id="site-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span />
          <div className="buttons">
            <button type="button" disabled={!endpoint.trim() || !token.trim() || busy} onClick={() => void testNew()}>
              Test
            </button>
            <button type="submit" disabled={!endpoint.trim() || !token.trim() || busy}>
              Add Site
            </button>
          </div>
        </form>
        <OutcomeLine outcome={addOutcome} />
      </fieldset>

      <fieldset className="group">
        <legend>Getting an access token</legend>
        <ol className="steps">
          <li>Sign in to Canvas in your web browser.</li>
          <li>
            Choose <b>Account</b>, then <b>Settings</b>.
          </li>
          <li>
            Under <b>Approved Integrations</b>, choose <b>+ New Access Token</b>.
          </li>
          <li>Type a purpose such as "edutools", leave the expiry date blank or pick one, and generate the token.</li>
          <li>Copy the token and paste it into the Access token box above. Canvas shows it only once.</li>
        </ol>
        <p className="muted">
          The token is stored in this computer's keychain, never in a file. Anyone with it can act in Canvas as you,
          so do not share it.
        </p>
      </fieldset>

      <fieldset className="group">
        <legend>Import from an earlier edutools</legend>
        <p>
          The edutools command line tool kept its token in <code>{info?.legacyPath ?? "~/.config/edutools/config.toml"}</code>.
          Importing moves that token into the keychain. The old file is left as it is.
        </p>
        <div className="buttons">
          <button type="button" disabled={busy} onClick={() => void importLegacy()}>
            Import
          </button>
        </div>
        <OutcomeLine outcome={importOutcome} />
      </fieldset>

      {info && (
        <p className="muted">
          edutools {info.version}. Site list: <code>{info.configPath}</code>
        </p>
      )}
    </div>
  );
}
