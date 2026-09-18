/**
 * Copies text, including on a plain-HTTP deployment.
 *
 * `navigator.clipboard` exists only in secure contexts (HTTPS, or localhost). Served
 * over plain HTTP from a real host name it is `undefined`, and calling
 * `navigator.clipboard.writeText` throws — the Copy button used to do exactly that,
 * silently. The fallback is the older selection-based copy, which browsers still
 * honour outside secure contexts as long as it happens during a user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Permission denied or similar: try the fallback below.
    }

    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off-screen, not display:none — a hidden element cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    try {
        // Deprecated, but it is the only copy path outside a secure context.
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
