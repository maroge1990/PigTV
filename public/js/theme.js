/**
 * Theme
 *
 * Three states: 'system', 'light', 'dark'. 'system' is the default and follows
 * prefers-color-scheme, which is what an OS-level appearance switch drives —
 * and what an iOS client would inherit for free later.
 *
 * The resolved theme is written to <html data-theme>, so CSS never needs to
 * know whether it came from a preference or a choice.
 */
const Theme = {
    KEY: 'pigtv_theme',

    get choice() {
        const v = localStorage.getItem(this.KEY);
        return (v === 'light' || v === 'dark') ? v : 'system';
    },

    systemPrefers() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light' : 'dark';
    },

    resolved() {
        const c = this.choice;
        return c === 'system' ? this.systemPrefers() : c;
    },

    apply() {
        document.documentElement.setAttribute('data-theme', this.resolved());
    },

    set(choice) {
        if (choice === 'system') {
            localStorage.removeItem(this.KEY);
        } else {
            localStorage.setItem(this.KEY, choice);
        }
        this.apply();
    },

    watchSystem() {
        if (!window.matchMedia) return;
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = () => { if (this.choice === 'system') this.apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
};

// Run immediately: waiting for DOMContentLoaded would flash the wrong theme.
Theme.apply();

window.Theme = Theme;
