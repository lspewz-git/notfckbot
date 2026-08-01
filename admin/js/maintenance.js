/** Operations that affect everyone at once: update check, broadcast, wipe. */

import { $ } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal, setReturnTo, clearReturnTo, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { BROADCAST_AUDIENCE_LABELS } from './format.js';

export async function triggerCheck() {
    closeModal('actions-modal');
    try {
        await api('/trigger-check', { method: 'POST' });
        toast('Update check triggered', 'success');
    } catch (e) {
        toast('Failed to trigger: ' + e.message, 'error');
    }
}

export function openBroadcastModal() {
    closeModal('actions-modal');
    setReturnTo(() => openModal('actions-modal'));
    $('broadcast-msg').value = '';
    setSelectValue('broadcast-target', 'all');
    openModal('broadcast-modal');
    $('broadcast-msg').focus();
}

export function sendBroadcast() {
    const message = $('broadcast-msg').value.trim();
    if (!message) return toast('Enter a message first', 'warning');

    const target = $('broadcast-target').value;

    showConfirm({
        title: '📢 Send broadcast?',
        text: `This sends the message to ${BROADCAST_AUDIENCE_LABELS[target]}. Delivery cannot be undone or recalled.`,
        confirmLabel: 'Yes, send',
        cancelLabel: 'No, cancel',
        onConfirm: async () => {
            const btn = $('send-broadcast');
            btn.disabled = true;
            btn.innerText = 'Sending...';

            try {
                const res = await api('/broadcast', { method: 'POST', body: { message, target } });
                const failed = res.failCount ? `, ${res.failCount} failed` : '';
                toast(`Delivered to ${res.successCount} chats${failed}`, res.failCount ? 'warning' : 'success');
                clearReturnTo();
                closeModal('broadcast-modal');
                $('broadcast-msg').value = '';
            } catch (e) {
                toast('Broadcast failed: ' + e.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = 'Send Broadcast';
            }
        }
    });
}

export function confirmWipeAll() {
    showConfirm({
        title: '⚠️ Wipe all data?',
        text: 'This empties the entire database — all chats, subscriptions, series and watchlist entries. Every user will have to start over with /start. This cannot be undone.',
        confirmLabel: 'Yes, wipe',
        cancelLabel: 'No, keep my data',
        onConfirm: async () => {
            const res = await mutate('/clear-all', { method: 'POST' }, (r) => {
                const d = r.deleted || {};
                return `Wiped ${d.chats ?? 0} chats, ${d.subscriptions ?? 0} subscriptions, ${d.watchlist ?? 0} watchlist entries, ${d.series ?? 0} series.`;
            });
            if (res) closeModal('danger-modal');
        }
    });
}
