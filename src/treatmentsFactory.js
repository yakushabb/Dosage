'use strict';

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

export const treatmentsFactory = new Gtk.SignalListItemFactory();

treatmentsFactory.connect('setup', (factory, listItem) => {
	const box = new Gtk.Box({
		css_classes: ['card'],
		height_request: 64,
	});
	const icon = new Gtk.Image({
		margin_start: 18,
		margin_end: 6,
		icon_name: 'pill-symbolic',
	});
	box.append(icon);
	const labelsBox = new Gtk.Box({
		valign: Gtk.Align.CENTER,
		hexpand: true,
		orientation: Gtk.Orientation.VERTICAL,
		margin_start: 8,
		margin_end: 12,
	});
	box.append(labelsBox);
	const name = new Gtk.Label({
		halign: Gtk.Align.START,
		margin_bottom: 1,
	});
	labelsBox.append(name);
	const info = new Gtk.Label({
		css_classes: ['subtitle'],
		halign: Gtk.Align.START,
		ellipsize: Pango.EllipsizeMode.END,
	});
	labelsBox.append(info);
	const durationNextDateLabel = new Gtk.Label({
		css_classes: ['subtitle'],
		halign: Gtk.Align.START,
		ellipsize: Pango.EllipsizeMode.END,
		visible: false,
		margin_top: 1,
	});
	labelsBox.append(durationNextDateLabel);
	const inventoryLabel = new Gtk.Label({
		css_classes: ['rounded-label'],
		valign: Gtk.Align.CENTER,
		margin_end: 5,
		visible: false,
		ellipsize: Pango.EllipsizeMode.END,
	});
	box.append(inventoryLabel);
	const editIcon = new Gtk.Image({
		margin_start: 13,
		margin_end: 18,
		icon_name: 'document-edit-symbolic',
	});
	box.append(editIcon);
	listItem.set_child(box);
});

treatmentsFactory.connect('bind', (factory, listItem) => {
	const item = listItem.get_item();
	const info = item.info;
	const box = listItem.get_child();
	const row = box.get_parent();
	const icon = box.get_first_child();
	const labelsBox = icon.get_next_sibling();
	const nameLabel = labelsBox.get_first_child();
	const infoLabel = nameLabel.get_next_sibling();
	const durationNextDateLabel = infoLabel.get_next_sibling();
	const inventoryLabel = box.get_last_child().get_prev_sibling();

	// activate item with space bar
	const keyController = new Gtk.EventControllerKey();
	keyController.connect('key-pressed', (_, keyval, keycode, state) => {
		if (keyval === Gdk.KEY_space) {
			const listView = row.get_parent();
			listView.emit('activate', listItem.position);
		}
	});
	row.add_controller(keyController);

	row.remove_css_class('activatable');
	box.add_css_class('activatable');

	nameLabel.label = item.name;

	const inv = info.inventory;
	
	if (inv.enabled) {
		let currInv = inv.current < 0 ? 0 : inv.current;

		inventoryLabel.set_visible(true);
		inventoryLabel.label = `${currInv} ` + _('Remaining');
		
		if (inv.current <= inv.reminder) {
			inventoryLabel.add_css_class('low-stock-label');
			inventoryLabel.label = `${currInv} ↓ ` + _('Low stock');
		}
	}

	const untilDate = new Date(info.duration.end).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});

	// TRANSLATORS: label for when duration is enabled
	const untilLabel = _('Until') + ` ${untilDate}`;

	if (info.duration.enabled) {
		durationNextDateLabel.set_visible(true);
		durationNextDateLabel.label = untilLabel;
	}

	switch (info.frequency) {
		case 'daily':
			infoLabel.label = _('Daily');
			break;
		case 'specific-days':
			const isWeekend = info.days.every(day => [0, 6].includes(day));
			const isWeekdays = info.days.every(day => [1, 2, 3, 4, 5].includes(day));
			
			if (info.days.length === 1) {
				infoLabel.label = getDayLabel(info.days[0]);
			} else if (isWeekend) {
				infoLabel.label = _('Weekend');
			} else if (isWeekdays && info.days.length === 5) {
				infoLabel.label = _('Weekdays');
			} else if (info.days.length === 7) {
				infoLabel.label = _('Daily');
			} else {
				info.days.forEach(day => infoLabel.label += getDayLabel(day).slice(0, 3) + ',  ');
				infoLabel.label = infoLabel.label.slice(0, -3);
			}
			function getDayLabel(day) {
				const dayLabels = [
					_('Sunday'),
					_('Monday'),
					_('Tuesday'),
					_('Wednesday'),
					_('Thursday'),
					_('Friday'),
					_('Saturday'),
				];
				return dayLabels[day];
			}
			break;
		case 'cycle':
			const today = new Date().setHours(0, 0, 0, 0);
			const nextDt = new Date(item.info.cycleNextDate).setHours(0, 0, 0, 0);
			const nextDate = new Date(nextDt).toLocaleDateString(undefined, {
				weekday: 'short',
				month: 'short',
				day: 'numeric',
			});

			if (info.duration.enabled) {
				durationNextDateLabel.label = untilLabel;
				if (nextDt > today) {
					durationNextDateLabel.label += '  •  ' + _('Next dose') + `: ${nextDate}`;
				}
			} else if (nextDt > today) {
				durationNextDateLabel.label = _('Next dose') + `: ${nextDate}`;
			}
			
			if (nextDt <= today && !info.duration.enabled) {
				durationNextDateLabel.set_visible(false);
			} else {
				durationNextDateLabel.set_visible(true);
			}

			infoLabel.label = _('Cycle') + '  •  ';
			infoLabel.label += `${info.cycle[0]}` + ' ⊷ ' + `${info.cycle[1]}`;
			break;
		case 'when-needed':
			infoLabel.label = _('When necessary');
			break;
	}

	if (info.notes !== '') {
		infoLabel.label += `  •  ${info.notes}`;
	}

	const colors = [
		'default', 'red', 'orange', 'yellow',
		'green', 'cyan', 'blue', 'purple'
	];
	colors.forEach(c => box.remove_css_class(c));
	
	box.add_css_class(info.color);

	icon.icon_name = info.icon;
});
