import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, execCopy } from './queries';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

let execCommand: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // jsdom has no execCommand; record where the helper textarea lived and what was selected.
  execCommand = vi.fn(() => true);
  (document as unknown as { execCommand: unknown }).execCommand = execCommand;
});
afterEach(() => {
  document.body.innerHTML = '';
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await copyText('http://nas.local/s/abc');
    expect(writeText).toHaveBeenCalledWith('http://nas.local/s/abc');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the clipboard API is missing (plain http)', async () => {
    setClipboard(undefined);
    await copyText('http://nas.local/s/abc');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) });
    await copyText('x');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects only when both paths fail', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('no')) });
    execCommand.mockReturnValue(false);
    await expect(copyText('x')).rejects.toThrow();
    execCommand.mockImplementation(() => { throw new Error('unsupported'); });
    await expect(copyText('x')).rejects.toThrow();
  });
});

describe('execCopy', () => {
  it('copies from inside the focused dialog and gives the focus back', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    let host: Element | null = null;
    let selected = '';
    execCommand.mockImplementation(() => {
      const ta = document.activeElement as HTMLTextAreaElement;
      host = ta.parentElement;
      selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return true;
    });

    expect(execCopy('http://nas.local/s/abc')).toBe(true);
    expect(host).toBe(dialog);
    expect(selected).toBe('http://nas.local/s/abc');
    expect(document.activeElement).toBe(button);
    expect(dialog.querySelector('textarea')).toBeNull();
  });

  it('hosts the textarea in the trigger\'s dialog when the click left focus on the body (Safari)', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    let host: Element | null = null;
    execCommand.mockImplementation(() => { host = (document.activeElement as HTMLElement).parentElement; return true; });
    expect(execCopy('x', button)).toBe(true);
    expect(host).toBe(dialog);
    expect(document.activeElement).toBe(button);
    expect(dialog.querySelector('textarea')).toBeNull();
  });

  it('passes the trigger through copyText', async () => {
    setClipboard(undefined);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    let host: Element | null = null;
    execCommand.mockImplementation(() => { host = (document.activeElement as HTMLElement).parentElement; return true; });
    await copyText('x', button);
    expect(host).toBe(dialog);
  });

  it('uses the body outside dialogs and reports failure', () => {
    let host: Element | null = null;
    execCommand.mockImplementation(() => { host = (document.activeElement as HTMLElement).parentElement; return false; });
    expect(execCopy('x')).toBe(false);
    expect(host).toBe(document.body);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
