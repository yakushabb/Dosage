/*
 * Copyright 2023 Diego Povliuk
 * SPDX-License-Identifier: GPL-3.0-only
 */
'use strict';

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { MedicationObject } from './medication.js';
import { todayHeaderFactory, todayItemFactory } from './todayFactory.js';
import { historyHeaderFactory, historyItemFactory, removedItem } from './historyFactory.js';
import { treatmentsFactory } from './treatmentsFactory.js';
import openMedicationWindow from './medWindow.js';
import upgradeItems from './upgradeItems.js';

import {
	HistorySorter,
	HistorySectionSorter,
	TodaySectionSorter,
	DataDir,
	addLeadZero,
	createTempObj,
	isTodayMedDay,
	datesPassedDiff,
	clockIs12,
	getWidgetByName,
	amPmStr,
} from './utils.js';

export const historyLS = Gio.ListStore.new(MedicationObject);
export const treatmentsLS = Gio.ListStore.new(MedicationObject);

export const flow = { itemsChanged: false, delay: false };

export const DosageWindow = GObject.registerClass(
	{
		GTypeName: 'DosageWindow',
		Template: 'resource:///io/github/diegopvlk/Dosage/ui/window.ui',
		InternalChildren: [
			'todayList',
			'historyList',
			'treatmentsList',
			'treatmentsPage',
			'emptyToday',
			'emptyHistory',
			'emptyTreatments',
			'headerBarSpinner',
			'skipBtn',
			'entryBtn',
			'unselectBtn',
		],
	},
	class DosageWindow extends Adw.ApplicationWindow {
		constructor(application) {
			super({ application });
			this.#loadSettings();
			this.#start();
			this.#clockTick();
		}

		#loadSettings() {
			const appId = this.get_application().get_application_id();
			globalThis.settings = new Gio.Settings({ schemaId: appId });
			settings.bind('window-width', this, 'default-width', Gio.SettingsBindFlags.DEFAULT);
			settings.bind('window-height', this, 'default-height', Gio.SettingsBindFlags.DEFAULT);
			settings.connect('changed::clear-old-hist', (sett, key) => {
				if (sett.get_boolean(key) === true) {
					this._clearOldHistoryEntries();
					this._updateJsonFile('history', historyLS);
				}
			});
		}

		#start() {
			const load = () => {
				this._loadData();
				this._setEmptyHistLabel();
				this._updateCycleAndLastUp();
				this._updateJsonFile('treatments', treatmentsLS);
				this._loadToday();
				this._handleSuspension();
				this._scheduleNotifications();
				this._checkInventory();
			};

			const loadPromise = new Promise((resolve, reject) => resolve());
			loadPromise.then(_ => {
				setTimeout(() => load(), 100);
			});
		}

		_loadData() {
			const treatmentsFile = DataDir.get_child('dosage-treatments.json');
			const historyFile = DataDir.get_child('dosage-history.json');

			this._createOrLoadJson('treatments', treatmentsFile);
			this._createOrLoadJson('history', historyFile);
			if (this._addMissedItems() | this._clearOldHistoryEntries()) {
				this._updateJsonFile('history', historyLS);
				this._historyList.scroll_to(0, null, null);
			}
		}

		_checkInventory(notifAction) {
			this._treatmentsPage.set_needs_attention(false);
			this._treatmentsPage.badge_number = 0;
			let notify = false;

			for (const it of treatmentsLS) {
				const item = it.obj;
				const whenNeeded = item.frequency === 'when-needed';
				const today = new Date().setHours(0, 0, 0, 0);
				const end = new Date(item.duration.end).setHours(0, 0, 0, 0);
				const ended = item.duration.enabled && end < today;
				const inv = item.inventory;

				if (inv.enabled && inv.current <= inv.reminder) {
					this._treatmentsPage.set_needs_attention(true);
					this._treatmentsPage.badge_number += 1;
					if (!notify) notify = !ended && !whenNeeded;
				}
			}

			if (!this.get_visible() && !notifAction && notify) {
				const [notification, app] = this._getNotification();
				notification.set_title(_('Reminder'));
				// TRANSLATORS: Notification text for when the inventory is low
				notification.set_body(_('You have treatments low in stock'));
				app.send_notification('low-stock', notification);
			}

			// reload-ish of treatments list
			// necessary for updating low stock label
			this._treatmentsList.model = new Gtk.NoSelection({
				model: treatmentsLS,
			});
		}

		#clockTick() {
			let lastDate = new Date().setHours(0, 0, 0, 0);

			const tick = () => {
				const now = new Date().setHours(0, 0, 0, 0);
				// update everything at next midnight
				if (now > lastDate) {
					this._clearOldHistoryEntries();
					this._addMissedItems();
					this._updateEverything();
					this._historyList.scroll_to(0, null, null);
					this._scheduleNotifications();
					lastDate = now;
				}
			};

			setInterval(tick, 2500);
		}

		_handleSuspension() {
			const onWakingUp = () => this._scheduleNotifications('sleep');
			this._connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
			this._connection.signal_subscribe(
				'org.freedesktop.login1',
				'org.freedesktop.login1.Manager',
				'PrepareForSleep',
				'/org/freedesktop/login1',
				null,
				Gio.DBusSignalFlags.NONE,
				onWakingUp,
			);
		}

		_createOrLoadJson(fileType, file) {
			const filePath = file.get_path();

			if (!file.query_exists(null)) {
				try {
					this._createNewFile(filePath, fileType);
					log(`New ${fileType} file created at: ${filePath}`);
				} catch (err) {
					console.error(`Failed to create new ${fileType} file: ${err}`);
				}
			}

			this._loadJsonContents(fileType, filePath);
		}

		_createNewFile(filePath, fileType) {
			const file = Gio.File.new_for_path(filePath);
			const flags = Gio.FileCreateFlags.NONE;
			const fileStream = file.create(flags, null);

			if (!fileStream) {
				throw new Error('Failed to create the file:', filePath);
			}

			const outputStream = new Gio.DataOutputStream({
				base_stream: fileStream,
			});

			if (fileType === 'treatments') {
				outputStream.put_string('{ "treatments": [], "lastUpdate": "" }', null);
			} else if (fileType === 'history') {
				outputStream.put_string('{ "history": {} }', null);
			}

			outputStream.close(null);
			fileStream.close(null);
		}

		_loadJsonContents(fileType, filePath) {
			const file = Gio.File.new_for_path(filePath);
			const decoder = new TextDecoder('utf8');

			try {
				let [success, contents, length] = file.load_contents(null);

				if (success) {
					const contentString = decoder.decode(contents);
					if (fileType === 'treatments') {
						let treatments = JSON.parse(contentString);
						const upgradedTreatments = upgradeItems(treatments, fileType);
						if (upgradedTreatments) {
							treatments = upgradedTreatments;
						}
						this._loadTreatments(treatments);
						this.lastUpdate = treatments.lastUpdate;
					} else if (fileType === 'history') {
						let history = JSON.parse(contentString);
						const upgradedHistory = upgradeItems(history, fileType);
						if (upgradedHistory) {
							history = upgradedHistory;
						}
						this._loadHistory(history);
						if (upgradedHistory) {
							this._updateJsonFile('history', historyLS);
						}
					}
				} else {
					log('Failed to read file contents.');
				}
			} catch (err) {
				console.error(`Error reading the file ${fileType}:`, err);
			}
		}

		_loadTreatments(treatmentsJson) {
			try {
				if (treatmentsLS.get_n_items() === 0) {
					treatmentsJson.treatments.forEach(med => {
						treatmentsLS.insert_sorted(new MedicationObject({ obj: med }), (a, b) => {
							const name1 = a.obj.name;
							const name2 = b.obj.name;
							return name1.localeCompare(name2);
						});
					});

					this._treatmentsList.set_factory(treatmentsFactory);
					this._treatmentsList.remove_css_class('view');
					this._treatmentsList.add_css_class('background');

					this._treatmentsList.model = new Gtk.NoSelection({
						model: treatmentsLS,
					});
				}
			} catch (err) {
				console.error('Error loading treatments:', err);
			}
		}

		async _loadHistory(historyJson) {
			try {
				if (historyLS.get_n_items() === 0) {
					historyJson.history.forEach(med => {
						historyLS.append(new MedicationObject({ obj: med }));
					});

					this.sortedHistoryModel = await new Promise(resolve => {
						setTimeout(() => {
							resolve(
								new Gtk.SortListModel({
									model: historyLS,
									section_sorter: new HistorySectionSorter(),
									sorter: new HistorySorter(),
								}),
							);
						}, 100);
					});

					this._headerBarSpinner.set_visible(false);

					this._historyList.model = new Gtk.NoSelection({
						model: this.sortedHistoryModel,
					});

					this._historyList.remove_css_class('view');
					this._historyList.add_css_class('background');
					this._historyList.set_header_factory(historyHeaderFactory);
					this._historyList.set_factory(historyItemFactory);

					historyLS.connect('items-changed', (model, pos, removed, added) => {
						if (flow.itemsChanged) return;

						if (added && removed === 0) {
							const itemAdded = model.get_item(pos).obj;
							for (const it of treatmentsLS) {
								const item = it.obj;
								const sameItem =
									item.name === itemAdded.name &&
									item.inventory.enabled &&
									itemAdded.taken[1] === 1;

								if (sameItem) {
									item.inventory.current -= itemAdded.dose;
								}
							}
						}

						if (removed && removedItem) {
							const removedIt = removedItem.obj;
							const removedDt = new Date(removedIt.taken[0]);
							const date = removedDt.setHours(0, 0, 0, 0);
							const today = new Date().setHours(0, 0, 0, 0);
							if (date === today) {
								for (const it of treatmentsLS) {
									const item = it.obj;
									const sameItem = item.name === removedIt.name;
									if (sameItem) {
										item.dosage.forEach(timeDose => {
											for (const _i of this.todayLS) {
												const sameName = item.name === removedIt.name;
												const sameTime = String(timeDose.time) === String(removedIt.time);
												// update lastTaken when removing an item
												// with the same name, time and date of today item
												if (sameName && sameTime) {
													timeDose.lastTaken = null;
												}
											}
										});
										if (item.inventory.enabled && removedIt.taken[1] === 1) {
											item.inventory.current += removedIt.dose;
										}
									}
								}
							}
							this._updateEverything();
							this._scheduleNotifications('removing');
						}
					});
				}
			} catch (err) {
				console.error('Error loading history:', err);
			}

			this._setEmptyHistLabel();
		}

		_loadToday() {
			this.todayLS = Gio.ListStore.new(MedicationObject);

			for (const it of treatmentsLS) {
				const item = it.obj;
				item.dosage.forEach(timeDose => {
					this.todayLS.append(
						new MedicationObject({
							obj: {
								name: item.name,
								unit: item.unit,
								notes: item.notes,
								frequency: item.frequency,
								color: item.color,
								icon: item.icon,
								days: item.days,
								cycle: item.cycle,
								recurring: item.recurring,
								duration: item.duration,
								time: [timeDose.time[0], timeDose.time[1]],
								dose: timeDose.dose,
								lastTaken: timeDose.lastTaken,
							},
						}),
					);
				});
			}

			const filterTodayModel = new Gtk.FilterListModel({
				model: this.todayLS,
				filter: Gtk.CustomFilter.new(item => {
					return isTodayMedDay(item);
				}),
			});

			const sortedTodayModel = new Gtk.SortListModel({
				model: filterTodayModel,
				section_sorter: new TodaySectionSorter(),
			});

			this.todayItems = [];
			this.todayDosesHolder = [];
			this.todayModel = new Gtk.NoSelection({ model: sortedTodayModel });

			this._todayList.model = this.todayModel;
			this._todayList.remove_css_class('view');
			this._todayList.add_css_class('background');
			this._todayList.set_header_factory(todayHeaderFactory);
			this._todayList.set_factory(todayItemFactory);

			const noItems = sortedTodayModel.get_n_items() === 0;
			const noTreatments = this._treatmentsList.model.get_n_items() === 0;

			this._emptyTreatments.set_visible(noTreatments);

			if (noItems && noTreatments) {
				this._emptyToday.set_visible(true);
				this._emptyToday.set_icon_name('pill-symbolic');
				this._emptyToday.title = _('No treatments added yet');
			} else if (noItems) {
				this._emptyToday.set_visible(true);
				this._emptyToday.set_icon_name('all-done-symbolic');
				this._emptyToday.title = _('All done for today');
			} else {
				this._emptyToday.set_visible(false);
			}
		}

		_clearOldHistoryEntries() {
			if (!settings.get_boolean('clear-old-hist')) return;

			flow.itemsChanged = true;
			const itemsHolder = {};

			for (const it of historyLS) {
				const item = it.obj;
				const dateKey = new Date(item.taken[0]).setHours(0, 0, 0, 0);
				if (!itemsHolder[dateKey]) {
					itemsHolder[dateKey] = [];
				}
				itemsHolder[dateKey].push(new MedicationObject({ obj: item }));
			}

			historyLS.remove_all();

			const dateKeys = Object.keys(itemsHolder);

			for (const date of dateKeys.slice(0, 30)) {
				const itemsToAdd = itemsHolder[date];
				historyLS.splice(0, 0, itemsToAdd);
			}

			flow.itemsChanged = false;
			return true;
		}

		_scheduleNotifications(action) {
			for (const id in this.scheduledItems) {
				clearTimeout(this.scheduledItems[id]);
			}

			this.scheduledItems = {};
			this.todayGroupedObj = {};

			const todayLength = this.todayModel.get_n_items();

			for (let i = 0; i < todayLength; i++) {
				this._groupTodayList(this.todayModel.get_item(i));
			}

			this._addToBeNotified(action);
		}

		_groupTodayList(med) {
			const item = med.obj;
			const itemHour = item.time[0];
			const itemMin = item.time[1];

			const dateKey = new Date().setHours(itemHour, itemMin, 0, 0);

			if (!this.todayGroupedObj[dateKey]) {
				this.todayGroupedObj[dateKey] = [];
			}

			this.todayGroupedObj[dateKey].push(item);
		}

		_addToBeNotified(action) {
			for (let dateKey in this.todayGroupedObj) {
				const groupedObj = this.todayGroupedObj;
				const now = new Date();
				const hours = now.getHours();
				const minutes = now.getMinutes();
				const seconds = now.getSeconds();
				const date = new Date(+dateKey);
				const isSingleItem = groupedObj[dateKey].length === 1;
				const confirmStr = isSingleItem ? _('Confirm') : _('Confirm all');
				const skipStr = isSingleItem ? _('Skip') : _('Skip all');

				const itemHour = date.getHours();
				const itemMin = date.getMinutes();
				let timeDiff = (itemHour - hours) * 3600000 + (itemMin - minutes) * 60000 - seconds * 1000;

				const notify = () => {
					// notifications from the past will be sent again instantly (setTimeout is < 0)
					// when performing some action like saving/adding/updating/removing
					// because it needs to be rescheduled at every action
					// so don't send notifications in this case
					if (action && action != 'sleep' && timeDiff < 0) {
						timeDiff = 0;
						return;
					}
					const [notification, app] = this._getNotification();
					let h = itemHour;
					let m = itemMin;
					let period = '';

					if (clockIs12) {
						period = ` ${amPmStr[0]}`;
						if (h >= 12) period = ` ${amPmStr[1]}`;
						if (h > 12) h -= 12;
						if (h === 0) h = 12;
					}

					let body = '';
					const maxLength = 3;
					const itemsToDisplay = groupedObj[dateKey].slice(0, maxLength);

					body = itemsToDisplay.map(item => `${item.name} ⸱ ${item.dose} ${item.unit}`).join('\r');

					if (groupedObj[dateKey].length > maxLength) {
						const moreItemsCount = groupedObj[dateKey].length - maxLength;
						const text = `${itemsToDisplay.map(item => item.name).join(', ')} ${_(
							// TRANSLATORS: keep the %d it's where the number goes
							'and %d more',
						).replace('%d', moreItemsCount)}`;
						body = text;
					}

					h = clockIs12 ? String(h) : addLeadZero(h);
					notification.set_title(_('Reminder') + ` • ` + `${h}∶${addLeadZero(m)}` + period);
					notification.set_body(body);

					if (settings.get_boolean('confirm-button')) {
						notification.add_button(confirmStr, `app.confirm${dateKey}`);
					}

					if (settings.get_boolean('skip-button')) {
						notification.add_button(skipStr, `app.skip${dateKey}`);
					}

					const schedule = () => {
						this._updateEverything(null, 'notifAction');
						this._scheduleNotifications();
						this._historyList.scroll_to(0, null, null);
					};

					const confirmAction = new Gio.SimpleAction({
						name: `confirm${dateKey}`,
					});
					confirmAction.connect('activate', () => {
						const confirmPromise = new Promise((resolve, reject) => {
							resolve(
								groupedObj[dateKey].map(item => {
									this._addNotifItemToHistory(item, 1);
								}),
							);
						});
						confirmPromise.then(_ => schedule());
					});

					const skipAction = new Gio.SimpleAction({ name: `skip${dateKey}` });
					skipAction.connect('activate', () => {
						const skipPromise = new Promise((resolve, reject) => {
							resolve(
								groupedObj[dateKey].map(item => {
									this._addNotifItemToHistory(item, 0);
								}),
							);
						});
						skipPromise.then(_ => schedule());
					});

					app.add_action(confirmAction);
					app.add_action(skipAction);

					if (settings.get_boolean('sound') && action != 'sleep' && !this.played) {
						const ding = Gio.File.new_for_uri(
							'resource:///io/github/diegopvlk/Dosage/sounds/ding.ogg',
						);
						const mediaFile = Gtk.MediaFile.new_for_file(ding);
						mediaFile.play();

						// when using notification buttons, assuming the app is not visible,
						// all past items from today will be notified, so the user can see them all
						// so avoid playing the sound at every notification
						(async () => {
							this.played = true;
							await new Promise(res => setTimeout(res, 5000));
							this.played = false;
						})();
					}
					app.send_notification(`${dateKey}`, notification);
				};

				let recurringInterval = 99;
				let recurringEnabled = false;

				groupedObj[dateKey].map(item => {
					if (item.recurring.enabled) recurringEnabled = true;
					if (item.recurring.enabled && item.recurring.interval < recurringInterval) {
						recurringInterval = item.recurring.interval;
					}
				});

				if (recurringEnabled) {
					const interval = recurringInterval;
					const minutes = interval * 60 * 1000;
					const recurringNotify = (dateKey, timeDiff) => {
						this.scheduledItems[dateKey] = setTimeout(() => {
							notify();
							recurringNotify(dateKey, minutes);
						}, timeDiff);
					};

					recurringNotify(dateKey, timeDiff);
					continue;
				}

				this.scheduledItems[dateKey] = setTimeout(notify, timeDiff);
			}
		}

		_getNotification() {
			const app = this.get_application();
			const notification = new Gio.Notification();
			const openAction = new Gio.SimpleAction({ name: 'open' });

			notification.set_default_action('app.open');
			openAction.connect('activate', () => {
				app.activate();
				this.present();
			});
			app.add_action(openAction);

			const priorityState = settings.get_boolean('priority');
			const priority = priorityState
				? Gio.NotificationPriority.URGENT
				: Gio.NotificationPriority.NORMAL;
			notification.set_priority(priority);
			notification.set_title(_('Dosage'));

			return [notification, app];
		}

		_selectTodayItems(list, position, groupCheck) {
			const model = list.get_model();

			let rowItemPos = 0;
			let currentRow = list.get_first_child();

			while (currentRow) {
				if (currentRow.get_name() === 'GtkListItemWidget') {
					if (position === rowItemPos) {
						const doseAndNotes = getWidgetByName(currentRow, 'doseAndNotes');
						const checkButton = getWidgetByName(currentRow, 'checkButton');
						const amountBtn = getWidgetByName(currentRow, 'amountBtn');
						const amtSpinRow = getWidgetByName(currentRow, 'amtSpinRow');
						const item = model.get_item(position).obj;
						const indexToRemove = this.todayItems.indexOf(item);
						let isActive = checkButton.get_active();

						if (groupCheck) isActive = false;

						if (!isActive) {
							const d = item.dose;
							if (!this.todayItems.includes(item)) {
								this.todayItems.push(item);
								this.todayDosesHolder.push(d);
							}
						} else {
							const storedDose = this.todayDosesHolder[indexToRemove];
							item.dose = storedDose;
							doseAndNotes.label = doseAndNotes.label.replace(/^[^\s]+/, item.dose);
							this.todayItems.splice(indexToRemove, 1);
							this.todayDosesHolder.splice(indexToRemove, 1);
						}

						amtSpinRow.set_value(item.dose);
						amtSpinRow.connect('output', row => {
							doseAndNotes.label = doseAndNotes.label.replace(/^[^\s]+/, row.get_value());
							item.dose = row.get_value();
						});

						checkButton.set_active(!isActive);
						amountBtn.set_visible(!isActive);
					}
					rowItemPos++;
				}
				currentRow = currentRow.get_next_sibling();
			}

			const hasTodayItems = this.todayItems.length > 0;
			this._updateEntryBtn(hasTodayItems);
		}

		_unselectTodayItems() {
			this._loadToday();
			this._updateEntryBtn(false);
		}

		_updateEntryBtn(hasTodayItems) {
			this._entryBtn.label = hasTodayItems ? _('Confirm') : _('One-time entry');
			this._skipBtn.set_visible(hasTodayItems);
			this._unselectBtn.set_visible(hasTodayItems);

			if (hasTodayItems) {
				this._entryBtn.add_css_class('suggested-action');
			} else {
				this._entryBtn.remove_css_class('suggested-action');
				this.todayItems = [];
				this.todayDosesHolder = [];
			}
		}

		_addTodayToHistory(btn) {
			const taken = +btn.get_name(); // 1 or 0

			if (this.todayItems.length > 0) {
				this.todayItems.forEach(item => {
					this._insertItemToHistory(item, taken);
					const app = this.get_application();
					const itemHour = item.time[0];
					const itemMin = item.time[1];
					const dateKey = new Date().setHours(itemHour, itemMin, 0, 0);
					app.withdraw_notification(`${dateKey}`);
				});

				this._updateEverything();
				this._scheduleNotifications('adding');
				this._historyList.scroll_to(0, null, null);
			} else {
				// one-time entry
				this._openMedWindow(null, null, 'one-time');
			}

			this._updateEntryBtn(false);
		}

		_addNotifItemToHistory(item, taken) {
			const todayLength = this.todayModel.get_n_items();
			// only insert to history if item is not in today list
			for (let i = 0; i < todayLength; i++) {
				const it = this.todayModel.get_item(i)?.obj;
				const sameName = item.name === it?.name;
				const itemTime = String(item.time);
				const sameTime = itemTime === String(it?.time);

				if (sameName && sameTime) {
					this._insertItemToHistory(item, taken, null, true);
				}
			}
		}

		_insertItemToHistory(item, taken, missedDate, isNotif) {
			// taken values: -1 = missed, 0 = skipped, 1 = confirmed
			historyLS.insert_sorted(
				new MedicationObject({
					obj: {
						name: item.name,
						unit: item.unit,
						time: item.time,
						dose: item.dose,
						color: item.color,
						taken: [missedDate || new Date().getTime(), taken],
					},
				}),
				(a, b) => {
					return a.obj.taken[0] > b.obj.taken[0] ? -1 : 0;
				},
			);

			// update lastTaken of treatment dose when confirming/skipping
			if (!missedDate) {
				for (const it of treatmentsLS) {
					const treatItem = it.obj;
					const sameName = item.name === treatItem.name;
					const itemTime = String(item.time);

					if (sameName) {
						treatItem.dosage.forEach(timeDose => {
							const sameTime = itemTime === String(timeDose.time);
							const notifItem = isNotif && sameTime;
							const todayItem = this.todayItems.some(_i => sameName && sameTime);

							if (notifItem || todayItem) {
								timeDose.lastTaken = new Date().toISOString();
							}
						});
					}
				}
			}
		}

		_editHistoryItem(list, position) {
			this._openMedWindow(list, position, 'edit-hist');
		}

		_updateJsonFile(type, listStore) {
			const fileName = `dosage-${type}.json`;
			const file = DataDir.get_child(fileName);
			const tempObj = createTempObj(type, listStore);

			if (!tempObj) return;

			const updateFile = () => {
				return new Promise((resolve, reject) => {
					const byteArray = new TextEncoder().encode(JSON.stringify(tempObj));
					file.replace_contents_async(
						GLib.Bytes.new(byteArray),
						null,
						false,
						Gio.FileCreateFlags.REPLACE_DESTINATION,
						null,
						(file, result, userData) => {
							try {
								file.replace_contents_finish(result);
							} catch (err) {
								console.error(`Update of ${fileName} failed: ${err}`);
								reject(err);
							}
						},
						null,
					);
				});
			};

			updateFile()
				.then(() => {})
				.catch(err => console.error('Update failed:', err));
		}

		_addMissedItems() {
			let itemsAdded = false;
			flow.itemsChanged = true;

			const insert = (timeDose, tempItem, nextDate) => {
				if (!timeDose.lastTaken) {
					const nextDt = new Date(nextDate);
					nextDt.setHours(23, 59, 59, 999);
					this._insertItemToHistory(tempItem, -1, nextDt.getTime());
					itemsAdded = true;
				}
			};

			const lastUpdate = new Date(this.lastUpdate);
			const today = new Date();
			const twoMonthsAgo = new Date();
			twoMonthsAgo.setMonth(today.getMonth() - 2);
			const daysDiff = Math.floor((today - lastUpdate) / 86400000);
			if (daysDiff >= 60) {
				// if the app was closed for more than 2 months
				// only add missed items from the last 2 months
				this.lastUpdate = twoMonthsAgo.toISOString();
			}

			today.setHours(0, 0, 0, 0);
			for (const it of treatmentsLS) {
				const nextDate = new Date(this.lastUpdate);
				const item = it.obj;
				const end = new Date(item.duration.end);
				const start = new Date(item.duration.start);
				nextDate.setHours(0, 0, 0, 0);
				end.setHours(0, 0, 0, 0);
				start.setHours(0, 0, 0, 0);

				let current = item.cycle[2];

				while (nextDate < today) {
					if (item.duration.enabled && (start > nextDate || end < nextDate)) break;
					const [active, inactive] = item.cycle;
					item.dosage.forEach(timeDose => {
						const tempItem = { ...item };
						tempItem.time = [timeDose.time[0], timeDose.time[1]];
						tempItem.dose = timeDose.dose;
						switch (item.frequency) {
							case 'daily':
								insert(timeDose, tempItem, nextDate);
								break;
							case 'specific-days':
								if (item.days.includes(nextDate.getDay())) {
									insert(timeDose, tempItem, nextDate);
								}
								break;
							case 'cycle':
								if (current <= active) {
									insert(timeDose, tempItem, nextDate);
								}
								break;
						}
						// only the first date of confirmed/skipped items doens't get added
						// so set lastTaken to null after the first loop
						timeDose.lastTaken = null;
					});
					current += 1;
					if (current > active + inactive) current = 1;
					nextDate.setDate(nextDate.getDate() + 1);
				}
			}

			flow.itemsChanged = false;
			return itemsAdded;
		}

		_updateCycleAndLastUp() {
			const lastUpdate = new Date(this.lastUpdate);
			const lastUp = lastUpdate.setHours(0, 0, 0, 0);
			const today = new Date().setHours(0, 0, 0, 0);

			for (const it of treatmentsLS) {
				const item = it.obj;
				const start = new Date(item.duration.start).setHours(0, 0, 0, 0);

				function findDate(start) {
					let nextDtStr;
					let curr = item.cycle[2];
					let nextDate = start ? new Date(start) : new Date();
					nextDate.setHours(0, 0, 0, 0);

					while (true) {
						nextDtStr = nextDate.toISOString();
						const [active, inactive] = item.cycle;
						if (curr <= active) break;
						curr += 1;
						if (curr > active + inactive) curr = 1;
						nextDate.setDate(nextDate.getDate() + 1);
					}

					return nextDtStr;
				}

				if (item.frequency == 'cycle') {
					if (start < today) {
						const datesPassed = datesPassedDiff(lastUpdate, new Date());
						let [active, inactive, current] = item.cycle;

						for (let i = 0; i < datesPassed.length; i++) {
							current += 1;
							if (current > active + inactive) current = 1;
						}

						item.cycle[2] = current;
						item.cycleNextDate = findDate();
					} else {
						item.cycleNextDate = findDate(item.duration.start);
					}
				}
			}

			if (lastUp < today) this.lastUpdate = new Date().toISOString();
		}

		_setEmptyHistLabel() {
			if (historyLS.get_n_items() === 0) this._emptyHistory.set_visible(true);
			else this._emptyHistory.set_visible(false);
		}

		_updateEverything(skipHistUp, notifAction) {
			if (!skipHistUp) this._updateJsonFile('history', historyLS);
			this._updateCycleAndLastUp();
			this._updateJsonFile('treatments', treatmentsLS);
			this._loadToday();
			this._setEmptyHistLabel();
			this._updateEntryBtn(false);
			this._checkInventory(notifAction);
		}

		_openMedWindow(list, position, mode) {
			// artificial delay to avoid opening multiple sheets
			// when double clicking button
			if (!flow.delay) {
				openMedicationWindow(this, list, position, mode);
				flow.delay = true;
				setTimeout(() => {
					flow.delay = false;
				}, 500);
			}
		}
	},
);
