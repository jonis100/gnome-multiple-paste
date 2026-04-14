/*
 * Multiple Paste - GNOME Shell Clipboard History Manager
 * Copyright (c) 2026 jonis100
 * Licensed under MIT - see LICENSE file
 */

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import Pango from "gi://Pango";
import Shell from "gi://Shell";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const ENTRY_SEPARATOR = "\x1E"; // ASCII record separator
const PRIVATE_MIMES = ["x-kde-passwordManagerHint"];
const decoder = new TextDecoder();

// --- Clipboard watcher ---------------------------------------------------

const ClipboardWatcher = GObject.registerClass(
  { Signals: { "clip-changed": {} } },
  class ClipboardWatcher extends GObject.Object {
    _init() {
      super._init();
      this._board = St.Clipboard.get_default();
      const display = Shell.Global.get().get_display();
      this._sel = display.get_selection();
      this._sigId = this._sel.connect("owner-changed", (_sel, type) => {
        if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
          this.emit("clip-changed");
      });
    }

    read(cb) {
      const mimes = this._board.get_mimetypes(St.ClipboardType.CLIPBOARD);
      if (PRIVATE_MIMES.some((m) => mimes.includes(m))) {
        cb(null);
        return;
      }
      this._board.get_text(St.ClipboardType.CLIPBOARD, (_board, text) =>
        cb(text),
      );
    }

    write(text) {
      this._board.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    wipe() {
      this._board.set_content(
        St.ClipboardType.CLIPBOARD,
        "",
        new GLib.Bytes(null),
      );
    }

    dispose() {
      this._sel.disconnect(this._sigId);
    }
  },
);

// --- Persistent storage --------------------------------------------------

class StorageFile {
  constructor(path) {
    this._path = path;
    this._ensureFile();
  }
  f;

  _ensureFile() {
    const dir = Gio.File.new_for_path(GLib.path_get_dirname(this._path));
    if (!dir.query_exists(null)) dir.make_directory_with_parents(null);
    const f = Gio.File.new_for_path(this._path);
    if (!f.query_exists(null)) f.create(Gio.FileCreateFlags.NONE, null);
  }

  load(cb) {
    const f = Gio.File.new_for_path(this._path);
    f.load_contents_async(null, (file, res) => {
      const [, bytes] = file.load_contents_finish(res);
      const raw = decoder.decode(bytes);
      const entries =
        raw.length > 0
          ? raw.split(ENTRY_SEPARATOR).filter((s) => s.length > 0)
          : [];
      cb(entries);
    });
  }

  save(entries) {
    const data = entries.length > 0 ? entries.join(ENTRY_SEPARATOR) : "";
    const f = Gio.File.new_for_path(this._path);
    const out = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
    out.write_all(data, null);
    out.close(null);
  }
}

// --- Scrollable history section ------------------------------------------

class HistorySection extends PopupMenu.PopupMenuSection {
  constructor() {
    super();
    this.items = new PopupMenu.PopupMenuSection();
    this.scroll = new St.ScrollView({
      overlay_scrollbars: true,
      style_class: "mp-history-scroll",
    });
    this.scroll.add_child(this.items.actor);

    const wrapper = new PopupMenu.PopupMenuSection();
    wrapper.actor.add_child(this.scroll);
    this.addMenuItem(wrapper);
  }
}

// --- Panel button ---------------------------------------------------------

const IndicatorButton = GObject.registerClass(
  class IndicatorButton extends PanelMenu.Button {
    _init(ext, persist, settings) {
      super._init(0);
      this._ext = ext;
      this._persist = persist;
      this._settings = settings;
      this._activeItem = null;

      const storagePath = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        ext.uuid,
        "history.dat",
      ]);
      this._storage = new StorageFile(storagePath);

      this.menu.actor.add_style_class_name("mp-panel-menu");

      // Panel icon
      this.add_child(
        new St.Icon({
          gicon: new Gio.ThemedIcon({ name: "edit-paste-symbolic" }),
          style_class: "system-status-icon",
        }),
      );

      // Search bar
      this._searchEntry = new St.Entry({
        hint_text: "Search...",
        style_class: "mp-search-entry",
        can_focus: true,
        track_hover: true,
      });
      this._searchEntry.clutter_text.connect("text-changed", () =>
        this._filterRows(),
      );
      const searchSection = new PopupMenu.PopupMenuSection();
      searchSection.actor.add_child(this._searchEntry);
      this.menu.addMenuItem(searchSection);

      this._noResults = new St.Label({
        text: "No matches",
        style_class: "mp-no-results",
        visible: false,
      });
      const noResSection = new PopupMenu.PopupMenuSection();
      noResSection.actor.add_child(this._noResults);
      this.menu.addMenuItem(noResSection);

      // Menu layout
      this._history = new HistorySection();
      this._history.items.box.connect("child-added", () => this._refresh());
      this._removedSig = this._history.items.box.connect("child-removed", () =>
        this._refresh(),
      );
      this.menu.addMenuItem(this._history);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      const clearBtn = new PopupMenu.PopupMenuItem("Clear");
      clearBtn.connect("activate", () => {
        this.menu.close();
        if (this._activeItem) this._watcher.wipe();
        this._history.items.removeAll();
        this._storage.save([]);
      });
      this.menu.addMenuItem(clearBtn);

      this.menu.connect("open-state-changed", (_m, open) => {
        if (open) {
          this._searchEntry.set_text("");
          this._history.scroll.vadjustment.value = 0;
          // Defer focus so the menu is fully mapped before we grab input
          Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            global.stage.set_key_focus(this._searchEntry.clutter_text);
            return GLib.SOURCE_REMOVE;
          });
        }
      });

      // Redirect stray key presses back to the search entry
      this.menu.actor.connect("key-press-event", (_actor, event) => {
        const sym = event.get_key_symbol();
        // Ignore navigation / modifier-only keys
        if (
          sym === Clutter.KEY_Up ||
          sym === Clutter.KEY_Down ||
          sym === Clutter.KEY_Return ||
          sym === Clutter.KEY_Escape ||
          sym === Clutter.KEY_Tab
        )
          return Clutter.EVENT_PROPAGATE;

        const focused = global.stage.get_key_focus();
        if (focused !== this._searchEntry.clutter_text) {
          global.stage.set_key_focus(this._searchEntry.clutter_text);
          // Re-emit the event so the character is typed into the entry
          this._searchEntry.clutter_text.event(event, false);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      // Clipboard
      this._watcher = new ClipboardWatcher();
      this._watcherSig = this._watcher.connect("clip-changed", () => {
        this._watcher.read((text) => this._onNewClip(text));
      });

      // Keyboard shortcuts
      this._bindKeys();

      // Restore persisted state, or load cache if none
      if (!this._restoreState()) this._loadFromDisk();
    }

    destroy() {
      this._unbindKeys();
      this._saveState();
      this._history.items.box.disconnect(this._removedSig);
      this._watcher.disconnect(this._watcherSig);
      this._watcher.dispose();
      super.destroy();
    }

    // --- Keyboard shortcuts -------------------------------------------

    _bindKeys() {
      const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
      Main.wm.addKeybinding(
        "toggle-menu",
        this._settings,
        Meta.KeyBindingFlags.NONE,
        mode,
        () => this.menu.toggle(),
      );
    }

    _unbindKeys() {
      Main.wm.removeKeybinding("toggle-menu");
    }

    // --- State persistence across lock-screen re-enable cycles --------

    _restoreState() {
      if (this._persist.entries.length === 0) return false;
      for (const text of this._persist.entries)
        this._history.items.addMenuItem(this._buildRow(text));
      this._persist.entries.length = 0;

      this._watcher.read((text) => {
        if (!text || text.length === 0) return;
        const match = this._findRow(text);
        if (match) this._markActive(match);
      });
      this._refresh();
      return true;
    }

    _saveState() {
      const rows = this._history.items._getMenuItems();
      this._persist.entries = rows.map((r) => r._clipText);
    }

    // --- Disk cache ---------------------------------------------------

    _loadFromDisk() {
      this._storage.load((entries) => {
        for (const text of entries)
          this._history.items.addMenuItem(this._buildRow(text), 0);
      });
    }

    _writeDisk() {
      const rows = this._history.items._getMenuItems();
      this._storage.save(rows.map((r) => r._clipText));
    }

    // --- Build a single history row -----------------------------------

    _buildRow(text) {
      const row = new PopupMenu.PopupMenuItem(text);
      row._clipText = text;
      row.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

      row.connect("activate", () => {
        this.menu.close();
        this._watcher.write(row._clipText);
      });

      row.connect("destroy", () => {
        if (this._activeItem === row) this._activeItem = null;
      });

      // Delete button
      const icon = new St.Icon({
        gicon: new Gio.ThemedIcon({ name: "window-close-symbolic" }),
        style_class: "system-status-icon",
      });
      const btn = new St.Button({
        can_focus: true,
        child: icon,
        style_class: "mp-remove-btn",
      });
      btn.connect("clicked", () => {
        if (this._history.items.numMenuItems === 1) this.menu.close();
        this._removeRow(row);
      });

      const box = new St.BoxLayout({
        style_class: "mp-remove-box",
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
      });
      box.add_child(btn);
      row.actor.add_child(box);

      return row;
    }

    // --- Row helpers --------------------------------------------------

    _findRow(text) {
      return (
        this._history.items._getMenuItems().find((r) => r._clipText === text) ??
        null
      );
    }

    _removeRow(row) {
      if (this._activeItem === row) this._watcher.wipe();
      row.destroy();
      this._writeDisk();
    }

    _markActive(row) {
      if (this._activeItem === row) return;
      this._activeItem?.setOrnament(PopupMenu.Ornament.NONE);
      this._activeItem = row;
      row.setOrnament(PopupMenu.Ornament.NONE);
    }

    _filterRows() {
      const query = this._searchEntry.get_text().toLowerCase();
      let anyVisible = false;
      for (const row of this._history.items._getMenuItems()) {
        const match = !query || row._clipText.toLowerCase().includes(query);
        row.actor.visible = match;
        if (match) anyVisible = true;
      }
      this._noResults.visible = !anyVisible && query.length > 0;
    }

    _refresh() {
      this.visible = this._history.items.numMenuItems > 0;
    }

    // --- Clipboard change handler -------------------------------------

    _onNewClip(raw) {
      if (!raw) return;
      const text = raw.trim();
      if (!text) return;
      if (text.includes(ENTRY_SEPARATOR)) return;

      let row = this._findRow(text);
      if (row) {
        this._history.items.moveMenuItem(row, 0);
      } else {
        row = this._buildRow(text);
        this._history.items.addMenuItem(row, 0);

        // Enforce max size
        const maxEntries = this._settings.get_int("max-entries");
        const all = this._history.items._getMenuItems();
        while (all.length > maxEntries) all.pop().destroy();
      }

      this._markActive(row);
      this._writeDisk();
    }
  },
);

// --- Extension entry point ------------------------------------------------

export default class MultiplePasteExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._persist = { entries: [] };
  }

  enable() {
    this._settings = this.getSettings(
      "org.gnome.shell.extensions.multiple-paste",
    );
    this._btn = new IndicatorButton(this, this._persist, this._settings);
    Main.panel.addToStatusArea(this.metadata.name, this._btn);
  }

  disable() {
    this._btn.destroy();
    this._btn = null;
    this._settings = null;
  }
}
