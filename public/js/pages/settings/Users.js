/**
 * Settings › System › Users (admin): add, edit and delete accounts.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;

                try {
                    await API.users.create({ username, password, role });
                    UI.toast('User created.');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    UI.toast(UI.errorText(err, 'Could not add the user.'), { kind: 'error' });
                }
            });
        }
    },

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                UI.setState(userList, 'empty', { title: 'No users yet', detail: 'Add one below.' }, null, { colspan: 4 });
                return;
            }

            const e = (v) => UI.escape(v);
            userList.innerHTML = users.map(user => {
                const typeBadge = '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:var(--space-sm);">
                            <strong>${e(user.username)}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${roleBadge}</td>
                    <td><span class="pig-amount">${user.createdAt ? e(UI.date(user.createdAt)) : '–'}</span></td>
                    <td>
                        <button type="button" class="btn btn-sm btn-secondary" data-user-action="edit" data-user-id="${e(user.id)}">Edit</button>
                        <button type="button" class="btn btn-sm btn-error" data-user-action="delete" data-user-id="${e(user.id)}">Delete</button>
                    </td>
                </tr>
            `}).join('');

            // The buttons find their user by id in this.users, so no name is put into script.
            userList.querySelectorAll('[data-user-action]').forEach(button => {
                button.addEventListener('click', () => {
                    const user = this.users.find(u => String(u.id) === button.dataset.userId);
                    if (!user) return;
                    if (button.dataset.userAction === 'edit') this.openEditUserModal(user.id);
                    else this.deleteUser(user.id, user.username);
                });
            });
        } catch (err) {
            console.error('Error loading users:', err);
            UI.setState(userList, 'error', 'The users could not be loaded.', { run: () => this.loadUsers() }, { colspan: 4 });
        }
    },

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            UI.toast('The edit window is missing. Refresh the page and try again.', { kind: 'error' });
            return;
        }

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // A previous edit may have left the password field in another state; reset it.
            const passwordHint = document.getElementById('edit-password-hint');
            if (editPassword) {
                editPassword.disabled = false;
                editPassword.placeholder = "Leave blank to keep current";
            }
            if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";

            // Show it: Escape, the backdrop, the close button and Cancel close it; focus returns to the Edit button.
            this.setupModalHandlers(modal).open();
        } catch (err) {
            console.error('Error populating modal:', err);
            UI.toast(UI.errorText(err, 'Could not open the edit window.'), { kind: 'error' });
        }
    },

    setupModalHandlers(modal) {
        const dialog = UI.dialog.attach(modal);
        if (this.modalHandlersSetup) return dialog;

        const saveBtn = document.getElementById('edit-user-save');
        const closeModal = () => dialog.close();

        // Save Handler
        saveBtn.onclick = async () => {
            const userId = document.getElementById('edit-user-id').value;
            const updates = {
                username: document.getElementById('edit-username').value,
                role: document.getElementById('edit-role').value
            };

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            try {
                await API.users.update(userId, updates);
                closeModal();
                this.loadUsers();
            } catch (err) {
                UI.toast(UI.errorText(err, 'Could not save the user.'), { kind: 'error' });
            }
        };

        this.modalHandlersSetup = true;
        return dialog;
    },


    async deleteUser(userId, username) {
        if (!confirm(`Delete the user "${username}"? The account is removed and cannot be brought back.`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            UI.toast(UI.errorText(err, 'Could not delete the user.'), { kind: 'error' });
        }
    },
});
