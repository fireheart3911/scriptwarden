// src/components/QrCode.tsx — join-URL QR + copyable text (§3).
//
// Pulls the server's non-internal IPv4 URLs from /api/net-info and renders the
// selected one as a QR data-URL so a phone can scan straight into the Join
// screen. Multiple NICs => a small selector. Copy button for typing it manually.

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";

export function QrCode() {
  const [urls, setUrls] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .netInfo()
      .then((n) => setUrls(n.urls))
      .catch((e) => setErr(String(e)));
  }, []);

  const url = urls[idx];
  useEffect(() => {
    if (!url) {
      setDataUrl(null);
      return;
    }
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((d) => live && setDataUrl(d))
      .catch(() => live && setDataUrl(null));
    return () => {
      live = false;
    };
  }, [url]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure origin) — the text is visible to type */
    }
  }

  if (err) return <div className="hint">Couldn't read network info: {err}</div>;
  if (urls.length === 0)
    return <div className="hint">No LAN address found — is the server on wifi?</div>;

  return (
    <div className="qr">
      {dataUrl ? (
        <img className="qr-img" src={dataUrl} alt={`QR code for ${url}`} width={220} height={220} />
      ) : (
        <div className="qr-img qr-pending muted">generating…</div>
      )}
      <div className="qr-side">
        <div className="qr-label hint">Crew scan or type this in a browser:</div>
        <div className="qr-url">{url}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn-sm" onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          {urls.length > 1 && (
            <button className="btn-sm" onClick={() => setIdx((i) => (i + 1) % urls.length)}>
              Next address ({idx + 1}/{urls.length})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
