import React, { useEffect, useState } from "react";
import styles from "./PickerModal.module.css";
import { IconFolder } from "../components/icons";

export type PickerEntry = { name: string; path: string; kind: string };

export function PickerModal(props: {
  open: boolean;
  path: string;
  parent: string | null;
  entries: PickerEntry[];
  showHidden: boolean;
  formatPath?: (path: string) => string;
  busy?: boolean;
  message?: string | null;
  onClose: () => void;
  onUse: (path: string) => void;
  onSetPath: (path: string) => void;
  onGo: (path: string) => void | Promise<void>;
  onUp: (parent: string) => void | Promise<void>;
  onToggleHidden: (next: boolean) => void | Promise<void>;
  onCreateFolder: (name: string, parentPath: string) => void | Promise<void>;
}) {
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (props.open) setNewFolderName("");
  }, [props.open, props.path]);

  useEffect(() => {
    if (!props.open || typeof document === "undefined") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [props.open]);

  const folderEntries = props.entries.filter((e) => e.kind === "dir");
  const fileEntries = props.entries.filter((e) => e.kind !== "dir");
  const fmtPath = (p: string) => (props.formatPath ? props.formatPath(p) : p);

  if (!props.open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" onClick={props.onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div style={{ flex: 1 }}>
            <div className={styles.headerTitle}>Select Folder</div>
          </div>
          <div className={styles.headerPath}>{fmtPath(props.path || "")}</div>
          <button className={styles.btnGhost} onClick={props.onClose} style={{ padding: "8px" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>
            <div className={styles.flexRow}>
              <input
                className={styles.input}
                value={fmtPath(props.path)}
                onChange={(e) => props.onSetPath(e.target.value)}
                placeholder="~/path/to/workspace"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button className={styles.btn} disabled={Boolean(props.busy)} onClick={() => props.onGo(props.path)}>
                Go
              </button>
              {props.parent && (
                <button className={styles.btn} disabled={Boolean(props.busy)} onClick={() => props.onUp(props.parent!)}>
                  Up
                </button>
              )}
            </div>

            <div className={styles.flexRow}>
              <input
                className={styles.input}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder name..."
                autoCapitalize="none"
                autoCorrect="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void props.onCreateFolder(newFolderName, props.path);
                  }
                }}
              />
              <button
                className={styles.btn}
                disabled={Boolean(props.busy) || !newFolderName.trim()}
                onClick={() => void props.onCreateFolder(newFolderName, props.path)}
              >
                Create
              </button>
            </div>

            <div className={styles.flexRow} style={{ marginTop: "4px" }}>
              <button
                className={`${styles.btn} ${props.showHidden ? styles.btnPrimary : styles.btnGhost}`}
                disabled={Boolean(props.busy)}
                onClick={() => props.onToggleHidden(!props.showHidden)}
                style={{ width: "100%" }}
              >
                {props.showHidden ? "Hide dotfolders" : "Show dotfolders"}
              </button>
            </div>
          </div>

          <div className={styles.listHeader}>Folders · {folderEntries.length}</div>

          <div className={styles.list}>
            {folderEntries.map((e) => (
              <div className={styles.rowItem} key={e.path}>
                <div className={styles.rowContent} onClick={() => props.onGo(e.path)}>
                  <div className={styles.iconBox}>
                    <IconFolder />
                  </div>
                  <div className={styles.rowText}>
                    <div className={styles.rowTitle}>{e.name}</div>
                    <div className={styles.rowSub}>{fmtPath(e.path)}</div>
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <button
                    className={styles.selectBtn}
                    disabled={Boolean(props.busy)}
                    onClick={() => props.onUse(e.path)}
                  >
                    Select
                  </button>
                </div>
              </div>
            ))}
            {folderEntries.length === 0 && (
              <div className={styles.emptyState}>No folders in this directory.</div>
            )}
          </div>

          {fileEntries.length > 0 && (
            <>
              <div className={styles.listHeader}>Files · {fileEntries.length}</div>
              <div className={styles.list}>
                {fileEntries.map((e) => (
                  <div className={styles.rowItem} key={e.path} style={{ opacity: 0.6 }}>
                    <div className={styles.rowContent}>
                      <div className={styles.iconBox} style={{ background: "transparent" }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                      </div>
                      <div className={styles.rowText}>
                        <div className={styles.rowTitle}>{e.name}</div>
                        <div className={styles.rowSub}>{fmtPath(e.path)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className={styles.footer}>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              style={{ padding: "16px", fontSize: "16px" }}
              disabled={Boolean(props.busy)}
              onClick={() => props.onUse(props.path)}
            >
              Use Current Folder
            </button>
            <div className={styles.footerHint}>
              Tap a folder to open it, or <span style={{ color: "#fff" }}>Select</span> to use it directly.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
