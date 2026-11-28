/** Visible-section loading and refreshes after a change. */
import { t as i18nText } from './i18n.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { loadMine } from './account.js';

let currentSection = 'dashboard';
export const setSection = (id) => {
    currentSection = id;
};
let adminPromise = null;
export function loadAdmin() {
    return (adminPromise ||= import('./admin.js')
        .then((module) => {
            module.setupAdmin();
            return module;
        })
        .catch((err) => {
            adminPromise = null;
            throw err;
        }));
}

export async function fetchData() {
    if (document.body.classList.contains('signed-out')) return;
    const section = currentSection;
    try {
        if (section.startsWith('my-')) await loadMine(section);
        else await (await loadAdmin()).fetchAdminData(section);
    } catch (err) {
        console.error(i18nText('Fetch error:'), err);
    }
}

export async function mutate(path, options, success) {
    try {
        const data = await api(path, options);
        if (success) toast(typeof success === 'function' ? success(data) : success, 'success');
        fetchData();
        return data;
    } catch (err) {
        toast(err.message || i18nText('Request failed'), 'error');
        return null;
    }
}
