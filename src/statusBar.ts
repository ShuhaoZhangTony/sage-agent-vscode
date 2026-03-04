import * as vscode from "vscode";
import { checkHealth, getStudioConfig } from "./studioClient";

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "sageAgent.openStudio";
    this.setUnknown();
    this.item.show();
  }

  setConnecting(): void {
    if (this.disposed) return;
    this.item.text = "$(loading~spin) SAGE Studio";
    this.item.tooltip = "Connecting to sage-studio…";
    this.item.backgroundColor = undefined;
  }

  setStudioStatus(online: boolean): void {
    if (this.disposed) return;
    const { baseUrl } = getStudioConfig();
    if (online) {
      this.item.text = "$(pass-filled) SAGE Studio";
      this.item.tooltip = `sage-studio 已就绪 — 点击在浏览器中打开`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = "$(error) SAGE Studio";
      this.item.tooltip = `sage-studio not reachable at ${baseUrl}\nClick to retry`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    }
  }

  setUnknown(): void {
    if (this.disposed) return;
    this.item.text = "$(question) SAGE Studio";
    this.item.tooltip = "sage-studio: status unknown. Click to check.";
    this.item.backgroundColor = undefined;
  }

  async refresh(): Promise<void> {
    this.setConnecting();
    const healthy = await checkHealth();
    this.setStudioStatus(healthy);
  }

  dispose(): void {
    this.disposed = true;
    this.item.dispose();
  }
}
