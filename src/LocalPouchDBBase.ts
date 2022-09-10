// Base class of LocalPouchDB
// Split from LiveSync for libraryisation.
//
import xxhash from "xxhash-wasm";
import {
    Entry,
    EntryDoc,
    EntryDocResponse,
    EntryLeaf,
    EntryNodeInfo,
    NewEntry,
    PlainEntry,
    LoadedEntry,
    Credential,
    EntryMilestoneInfo,
    LOG_LEVEL,
    LEAF_WAIT_TIMEOUT,
    MAX_DOC_SIZE,
    MAX_DOC_SIZE_BIN,
    NODEINFO_DOCID,
    VER,
    MILSTONE_DOCID,
    DatabaseConnectingStatus,
    ChunkVersionRange,
    NoteEntry,
} from "./types.js";
import { RemoteDBSettings } from "./types";
import { resolveWithIgnoreKnownError, runWithLock, shouldSplitAsPlainText, splitPieces2, enableEncryption } from "./utils";
import { Logger } from "./logger";
import { checkRemoteVersion, putDesignDocuments } from "./utils_couchdb";
import { LRUCache } from "./LRUCache";

// when replicated, LiveSync checks chunk versions that every node used.
// If all minimum version of every devices were up, that means we can convert database automatically.

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
}

type ReplicationCallback = (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>;
export abstract class LocalPouchDBBase {
    auth: Credential;
    dbname: string;
    settings: RemoteDBSettings;
    localDatabase: PouchDB.Database<EntryDoc>;
    nodeid = "";
    isReady = false;

    h32: (input: string, seed?: number) => string;
    h32Raw: (input: Uint8Array, seed?: number) => number;
    hashCaches = new LRUCache();

    corruptedEntries: { [key: string]: EntryDoc } = {};
    remoteLocked = false;
    remoteLockedAndDeviceNotAccepted = false;

    changeHandler: PouchDB.Core.Changes<EntryDoc> = null;
    syncHandler: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc> = null;

    leafArrivedCallbacks: { [key: string]: (() => void)[] } = {};

    syncStatus: DatabaseConnectingStatus = "NOT_CONNECTED";
    docArrived = 0;
    docSent = 0;
    docSeq = "";

    isMobile = false;

    chunkVersion = -1;
    maxChunkVersion = -1;
    minChunkVersion = -1;
    needScanning = false;

    abstract id2path(filename: string): string;
    abstract path2id(filename: string): string;

    abstract CreatePouchDBInstance<T>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>


    cancelHandler<T extends PouchDB.Core.Changes<EntryDoc> | PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>>(handler: T): T {
        if (handler != null) {
            handler.removeAllListeners();
            handler.cancel();
            handler = null;
        }
        return null;
    }
    abstract beforeOnUnload(): void;
    onunload() {
        //this.kvDB.close();
        this.beforeOnUnload();
        this.leafArrivedCallbacks;
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.syncHandler = this.cancelHandler(this.syncHandler);
        this.localDatabase.removeAllListeners();
    }

    constructor(settings: RemoteDBSettings, dbname: string, isMobile: boolean) {
        this.auth = {
            username: "",
            password: "",
        };
        this.dbname = dbname;
        this.settings = settings;
        this.cancelHandler = this.cancelHandler.bind(this);
        this.isMobile = isMobile;
    }
    abstract onClose(): void;
    close() {
        Logger("Database closed (by close)");
        this.isReady = false;
        this.changeHandler = this.cancelHandler(this.changeHandler);
        if (this.localDatabase != null) {
            this.localDatabase.close();
        }
        this.onClose();
        // this.kvDB.close();
    }

    async isOldDatabaseExists() {
        const db = this.CreatePouchDBInstance<EntryDoc>(this.dbname + "-livesync", {
            auto_compaction: this.settings.useHistory ? false : true,
            revs_limit: 20,
            deterministic_revs: true,
            skip_setup: true,
        });
        try {
            const info = await db.info();
            Logger(info, LOG_LEVEL.VERBOSE);
            return db;
        } catch (ex) {
            return false;
        }
    }
    abstract onInitializeDatabase(): Promise<void>;
    async initializeDatabase(): Promise<boolean> {
        await this.prepareHashFunctions();
        if (this.localDatabase != null) this.localDatabase.close();
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.localDatabase = null;

        this.localDatabase = this.CreatePouchDBInstance<EntryDoc>(this.dbname + "-livesync-v2", {
            auto_compaction: this.settings.useHistory ? false : true,
            revs_limit: 100,
            deterministic_revs: true,
        });
        await this.onInitializeDatabase();
        //this.kvDB = await OpenKeyValueDatabase(this.dbname + "-livesync-kv");
        Logger("Database info", LOG_LEVEL.VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL.VERBOSE);
        Logger("Open Database...");
        // The sequence after migration.
        const nextSeq = async (): Promise<boolean> => {
            Logger("Database Info");
            Logger(await this.localDatabase.info(), LOG_LEVEL.VERBOSE);
            // initialize local node information.
            const nodeinfo: EntryNodeInfo = await resolveWithIgnoreKnownError<EntryNodeInfo>(this.localDatabase.get(NODEINFO_DOCID), {
                _id: NODEINFO_DOCID,
                type: "nodeinfo",
                nodeid: "",
                v20220607: true,
            });
            if (nodeinfo.nodeid == "") {
                nodeinfo.nodeid = Math.random().toString(36).slice(-10);
                await this.localDatabase.put(nodeinfo);
            }
            this.localDatabase.on("close", () => {
                Logger("Database closed.");
                this.isReady = false;
                this.localDatabase.removeAllListeners();
            });
            this.nodeid = nodeinfo.nodeid;
            await putDesignDocuments(this.localDatabase);

            // Tracings the leaf id
            const changes = this.localDatabase
                .changes({
                    since: "now",
                    live: true,
                    filter: (doc) => doc.type == "leaf",
                })
                .on("change", (e) => {
                    if (e.deleted) return;
                    this.leafArrived(e.id);
                    this.docSeq = `${e.seq}`;
                });
            this.changeHandler = changes;
            this.isReady = true;
            Logger("Database is now ready.");
            return true;
        };
        Logger("Checking old database", LOG_LEVEL.VERBOSE);
        const old = await this.isOldDatabaseExists();

        //Migrate.
        if (old) {
            const oi = await old.info();
            if (oi.doc_count == 0) {
                Logger("Old database is empty, proceed to next step", LOG_LEVEL.VERBOSE);
                // already converted.
                return nextSeq();
            }
            //
            Logger("We have to upgrade database..", LOG_LEVEL.NOTICE, "conv");
            try {

                // To debug , uncomment below.

                // this.localDatabase.destroy();
                // await delay(100);
                // this.localDatabase = new PouchDB<EntryDoc>(this.dbname + "-livesync-v2", {
                //     auto_compaction: this.settings.useHistory ? false : true,
                //     revs_limit: 100,
                //     deterministic_revs: true,
                // });
                const newDbStatus = await this.localDatabase.info();
                Logger("New database is initialized");
                Logger(newDbStatus);

                if (this.settings.encrypt) {
                    enableEncryption(old, this.settings.passphrase, true);
                }
                const rep = old.replicate.to(this.localDatabase, { batch_size: 25, batches_limit: 10 });
                rep.on("change", (e) => {
                    Logger(`Converting ${e.docs_written} docs...`, LOG_LEVEL.NOTICE, "conv");
                });
                const w = await rep;

                if (w.ok) {
                    Logger("Conversion completed!", LOG_LEVEL.NOTICE, "conv");
                    old.destroy(); // delete the old database.
                    this.isReady = true;
                    return await nextSeq();
                } else {
                    throw new Error("Conversion failed!");
                }
            } catch (ex) {
                Logger("Conversion failed!, If you are fully synchronized, please drop the old database in the Hatch pane in setting dialog. or please make an issue on Github.", LOG_LEVEL.NOTICE, "conv");
                Logger(ex);
                this.isReady = false;
                return false;
            }
        } else {
            return await nextSeq();
        }
    }

    async prepareHashFunctions() {
        if (this.h32 != null) return;
        const { h32, h32Raw } = await xxhash();
        this.h32 = h32;
        this.h32Raw = h32Raw;
    }

    // leaf waiting

    leafArrived(id: string) {
        if (typeof this.leafArrivedCallbacks[id] !== "undefined") {
            for (const func of this.leafArrivedCallbacks[id]) {
                func();
            }
            delete this.leafArrivedCallbacks[id];
        }
    }
    // wait
    waitForLeafReady(id: string): Promise<boolean> {
        return new Promise((res, rej) => {
            // Set timeout.
            const timer = setTimeout(() => rej(new Error(`Chunk reading timed out:${id}`)), LEAF_WAIT_TIMEOUT);
            if (typeof this.leafArrivedCallbacks[id] == "undefined") {
                this.leafArrivedCallbacks[id] = [];
            }
            this.leafArrivedCallbacks[id].push(() => {
                clearTimeout(timer);
                res(true);
            });
        });
    }

    async getDBLeaf(id: string, waitForReady: boolean): Promise<string> {
        // when in cache, use that.
        const leaf = this.hashCaches.revGet(id);
        if (leaf) {
            return leaf;
        }
        try {
            const w = await this.localDatabase.get(id);
            if (w.type == "leaf") {
                this.hashCaches.set(id, w.data);
                return w.data;
            }
            throw new Error(`Corrupted chunk detected: ${id}`);
        } catch (ex) {
            if (ex.status && ex.status == 404) {
                if (waitForReady) {
                    // just leaf is not ready.
                    // wait for on
                    if ((await this.waitForLeafReady(id)) === false) {
                        throw new Error(`time out (waiting chunk)`);
                    }
                    return this.getDBLeaf(id, false);
                } else {
                    throw new Error(`Chunk was not found: ${id}`);
                }
            } else {
                Logger(`Something went wrong while retrieving chunks`);
                throw ex;
            }
        }
    }

    async getDBEntryMeta(path: string, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
        // safety valve
        if (!this.isTargetFile(path)) {
            return false;
        }
        const id = this.path2id(path);
        try {
            let obj: EntryDocResponse = null;
            if (opt) {
                obj = await this.localDatabase.get(id, opt);
            } else {
                obj = await this.localDatabase.get(id);
            }
            const deleted = "deleted" in obj ? obj.deleted : undefined;
            if (!includeDeleted && deleted) return false;
            if (obj.type && obj.type == "leaf") {
                //do nothing for leaf;
                return false;
            }

            // retrieve metadata only
            if (!obj.type || (obj.type && obj.type == "notes") || obj.type == "newnote" || obj.type == "plain") {
                const note = obj as Entry;
                let children: string[] = [];
                let type: "plain" | "newnote" = "plain";
                if (obj.type == "newnote" || obj.type == "plain") {
                    children = obj.children;
                    type = obj.type;
                }
                const doc: LoadedEntry & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta = {
                    data: "",
                    _id: note._id,
                    ctime: note.ctime,
                    mtime: note.mtime,
                    size: note.size,
                    // _deleted: obj._deleted,
                    _rev: obj._rev,
                    _conflicts: obj._conflicts,
                    children: children,
                    datatype: type,
                    deleted: deleted,
                    type: type
                };
                return doc;
            }
        } catch (ex) {
            if (ex.status && ex.status == 404) {
                return false;
            }
            throw ex;
        }
        return false;
    }
    async getDBEntry(path: string, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        // safety valve
        if (!this.isTargetFile(path)) {
            return false;
        }
        const id = this.path2id(path);
        try {
            let obj: EntryDocResponse = null;
            if (opt) {
                obj = await this.localDatabase.get(id, opt);
            } else {
                obj = await this.localDatabase.get(id);
            }
            const deleted = "deleted" in obj ? obj.deleted : undefined;
            if (!includeDeleted && deleted) return false;
            if (obj.type && obj.type == "leaf") {
                //do nothing for leaf;
                return false;
            }

            //Check it out and fix docs to regular case
            if (!obj.type || (obj.type && obj.type == "notes")) {
                const note = obj as NoteEntry;
                const doc: LoadedEntry & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta = {
                    data: note.data,
                    _id: note._id,
                    ctime: note.ctime,
                    mtime: note.mtime,
                    size: note.size,
                    // _deleted: obj._deleted,
                    _rev: obj._rev,
                    _conflicts: obj._conflicts,
                    children: [],
                    datatype: "newnote",
                    deleted: deleted,
                    type: "newnote",
                };
                if (typeof this.corruptedEntries[doc._id] != "undefined") {
                    delete this.corruptedEntries[doc._id];
                }
                if (dump) {
                    Logger(`Simple doc`);
                    Logger(doc);
                }

                return doc;
                // simple note
            }
            if (obj.type == "newnote" || obj.type == "plain") {
                // search children
                try {
                    if (dump) {
                        Logger(`Enhanced doc`);
                        Logger(obj);
                    }
                    let children: string[] = [];

                    if (this.settings.readChunksOnline) {
                        const items = await this.CollectChunks(obj.children);
                        if (items) {
                            for (const v of items) {
                                if (v && v.type == "leaf") {
                                    children.push(v.data);
                                } else {
                                    if (!opt) {
                                        Logger(`Chunks of ${obj._id} are not valid.`, LOG_LEVEL.NOTICE);
                                        this.needScanning = true;
                                        this.corruptedEntries[obj._id] = obj;
                                    }
                                    return false;
                                }
                            }
                        } else {
                            if (opt) {
                                Logger(`Could not retrieve chunks of ${obj._id}. we have to `, LOG_LEVEL.NOTICE);
                                this.needScanning = true;
                            }
                            return false;
                        }
                    } else {
                        try {
                            children = await Promise.all(obj.children.map((e) => this.getDBLeaf(e, waitForReady)));
                            if (dump) {
                                Logger(`Chunks:`);
                                Logger(children);
                            }
                        } catch (ex) {
                            Logger(`Something went wrong on reading chunks of ${obj._id} from database, see verbose info for detail.`, LOG_LEVEL.NOTICE);
                            Logger(ex, LOG_LEVEL.VERBOSE);
                            this.corruptedEntries[obj._id] = obj;
                            return false;
                        }
                    }
                    const data = children.join("");
                    const doc: LoadedEntry & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta = {
                        data: data,
                        _id: obj._id,
                        ctime: obj.ctime,
                        mtime: obj.mtime,
                        size: obj.size,
                        // _deleted: obj._deleted,
                        _rev: obj._rev,
                        children: obj.children,
                        datatype: obj.type,
                        _conflicts: obj._conflicts,
                        deleted: deleted,
                        type: obj.type
                    };
                    if (dump) {
                        Logger(`therefore:`);
                        Logger(doc);
                    }
                    if (typeof this.corruptedEntries[doc._id] != "undefined") {
                        delete this.corruptedEntries[doc._id];
                    }
                    return doc;
                } catch (ex) {
                    if (ex.status && ex.status == 404) {
                        Logger(`Missing document content!, could not read ${obj._id} from database.`, LOG_LEVEL.NOTICE);
                        return false;
                    }
                    Logger(`Something went wrong on reading ${obj._id} from database:`, LOG_LEVEL.NOTICE);
                    Logger(ex);
                }
            }
        } catch (ex) {
            if (ex.status && ex.status == 404) {
                return false;
            }
            throw ex;
        }
        return false;
    }
    async deleteDBEntry(path: string, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        // safety valve
        if (!this.isTargetFile(path)) {
            return false;
        }
        const id = this.path2id(path);

        try {
            let obj: EntryDocResponse = null;
            return await runWithLock("file:" + id, false, async () => {
                if (opt) {
                    obj = await this.localDatabase.get(id, opt);
                } else {
                    obj = await this.localDatabase.get(id);
                }
                const revDeletion = opt && (("rev" in opt ? opt.rev : "") != "");

                if (obj.type && obj.type == "leaf") {
                    //do nothing for leaf;
                    return false;
                }
                //Check it out and fix docs to regular case
                if (!obj.type || (obj.type && obj.type == "notes")) {
                    obj._deleted = true;
                    const r = await this.localDatabase.put(obj);
                    Logger(`entry removed:${obj._id}-${r.rev}`);
                    if (typeof this.corruptedEntries[obj._id] != "undefined") {
                        delete this.corruptedEntries[obj._id];
                    }
                    return true;
                    // simple note
                }
                if (obj.type == "newnote" || obj.type == "plain") {
                    if (revDeletion) {
                        obj._deleted = true;
                    } else {
                        obj.deleted = true;
                        obj.mtime = Date.now();
                        if (this.settings.deleteMetadataOfDeletedFiles) {
                            obj._deleted = true;
                        }
                    }
                    const r = await this.localDatabase.put(obj);
                    Logger(`entry removed:${obj._id}-${r.rev}`);
                    if (typeof this.corruptedEntries[obj._id] != "undefined") {
                        delete this.corruptedEntries[obj._id];
                    }
                    return true;
                } else {
                    return false;
                }
            });
        } catch (ex) {
            if (ex.status && ex.status == 404) {
                return false;
            }
            throw ex;
        }
    }
    async deleteDBEntryPrefix(prefixSrc: string): Promise<boolean> {
        // delete database entries by prefix.
        // it called from folder deletion.
        let c = 0;
        let readCount = 0;
        const delDocs: string[] = [];
        const prefix = this.path2id(prefixSrc);
        do {
            const result = await this.localDatabase.allDocs({ include_docs: false, skip: c, limit: 100, conflicts: true });
            readCount = result.rows.length;
            if (readCount > 0) {
                //there are some result
                for (const v of result.rows) {
                    // let doc = v.doc;
                    if (v.id.startsWith(prefix) || v.id.startsWith("/" + prefix)) {
                        if (this.isTargetFile(this.id2path(v.id))) delDocs.push(v.id);
                        // console.log("!" + v.id);
                    } else {
                        if (!v.id.startsWith("h:")) {
                            // console.log("?" + v.id);
                        }
                    }
                }
            }
            c += readCount;
        } while (readCount != 0);
        // items collected.
        //bulk docs to delete?
        let deleteCount = 0;
        let notfound = 0;
        for (const v of delDocs) {
            try {
                await runWithLock("file:" + v, false, async () => {
                    const item = await this.localDatabase.get(v);
                    if (item.type == "newnote" || item.type == "plain") {
                        item.deleted = true;
                        if (this.settings.deleteMetadataOfDeletedFiles) {
                            item._deleted = true;
                        }
                        item.mtime = Date.now();
                    } else {
                        item._deleted = true;
                    }
                    await this.localDatabase.put(item);
                });

                deleteCount++;
            } catch (ex) {
                if (ex.status && ex.status == 404) {
                    notfound++;
                    // NO OP. It should be timing problem.
                } else {
                    throw ex;
                }
            }
        }
        Logger(`deleteDBEntryPrefix:deleted ${deleteCount} items, skipped ${notfound}`);
        return true;
    }
    async putDBEntry(note: LoadedEntry, saveAsBigChunk?: boolean) {
        //safety valve
        if (!this.isTargetFile(this.id2path(note._id))) {
            return;
        }

        // let leftData = note.data;
        const savedNotes = [];
        let processed = 0;
        let made = 0;
        let skipped = 0;
        const maxChunkSize = MAX_DOC_SIZE_BIN * Math.max(this.settings.customChunkSize, 1);
        let pieceSize = maxChunkSize;
        let plainSplit = false;
        let cacheUsed = 0;
        const userPasswordHash = this.h32Raw(new TextEncoder().encode(this.settings.passphrase));
        if (!saveAsBigChunk && shouldSplitAsPlainText(note._id)) {
            pieceSize = MAX_DOC_SIZE;
            plainSplit = true;
        }

        const minimumChunkSize = Math.min(Math.max(40, ~~(note.data.length / 100)), maxChunkSize);
        if (pieceSize < minimumChunkSize) pieceSize = minimumChunkSize;
        const newLeafs: EntryLeaf[] = [];

        const pieces = splitPieces2(note.data, pieceSize, plainSplit, minimumChunkSize, 0);
        for (const piece of pieces()) {
            processed++;
            let leafId = "";
            // Get hash of piece.
            let hashedPiece = "";
            let hashQ = 0; // if hash collided, **IF**, count it up.
            let tryNextHash = false;
            let needMake = true;
            const cache = this.hashCaches.get(piece);
            if (cache) {
                hashedPiece = "";
                leafId = cache;
                needMake = false;
                skipped++;
                cacheUsed++;
            } else {
                if (this.settings.encrypt) {
                    // When encryption has been enabled, make hash to be different between each passphrase to avoid inferring password.
                    hashedPiece = "+" + (this.h32Raw(new TextEncoder().encode(piece)) ^ userPasswordHash).toString(16);
                } else {
                    hashedPiece = this.h32(piece);
                }
                leafId = "h:" + hashedPiece;
                do {
                    let newLeafId = leafId;
                    try {
                        newLeafId = `${leafId}${hashQ}`;
                        const pieceData = await this.localDatabase.get<EntryLeaf>(newLeafId);
                        if (pieceData.type == "leaf" && pieceData.data == piece) {
                            leafId = newLeafId;
                            needMake = false;
                            tryNextHash = false;
                            this.hashCaches.set(piece, leafId);
                        } else if (pieceData.type == "leaf") {
                            Logger("hash:collision!!");
                            hashQ++;
                            tryNextHash = true;
                        } else {
                            leafId = newLeafId;
                            tryNextHash = false;
                        }
                    } catch (ex) {
                        if (ex.status && ex.status == 404) {
                            //not found, we can use it.
                            leafId = newLeafId;
                            needMake = true;
                            tryNextHash = false;
                        } else {
                            needMake = false;
                            tryNextHash = false;
                            throw ex;
                        }
                    }
                } while (tryNextHash);
                if (needMake) {
                    //have to make
                    const savePiece = piece;

                    const d: EntryLeaf = {
                        _id: leafId,
                        data: savePiece,
                        type: "leaf",
                    };
                    newLeafs.push(d);
                    this.hashCaches.set(piece, leafId);
                    made++;
                } else {
                    skipped++;
                }
            }
            savedNotes.push(leafId);
        }
        let saved = true;
        if (newLeafs.length > 0) {
            try {
                const result = await this.localDatabase.bulkDocs(newLeafs);
                for (const item of result) {
                    if (!(item as any).ok) {
                        if ((item as any).status && (item as any).status == 409) {
                            // conflicted, but it would be ok in children.
                        } else {
                            Logger(`Save failed:id:${item.id} rev:${item.rev}`, LOG_LEVEL.NOTICE);
                            Logger(item);
                            saved = false;
                        }
                    }
                }
            } catch (ex) {
                Logger("Chunk save failed:", LOG_LEVEL.NOTICE);
                Logger(ex, LOG_LEVEL.NOTICE);
                saved = false;
            }
        }
        if (saved) {
            Logger(`Content saved:${note._id} ,pieces:${processed} (new:${made}, skip:${skipped}, cache:${cacheUsed})`);
            const newDoc: PlainEntry | NewEntry = {
                children: savedNotes,
                _id: note._id,
                ctime: note.ctime,
                mtime: note.mtime,
                size: note.size,
                type: note.datatype,
            };
            // Here for upsert logic,
            await runWithLock("file:" + newDoc._id, false, async () => {
                try {
                    const old = await this.localDatabase.get(newDoc._id);
                    if (!old.type || old.type == "notes" || old.type == "newnote" || old.type == "plain") {
                        // simple use rev for new doc
                        newDoc._rev = old._rev;
                    }
                } catch (ex) {
                    if (ex.status && ex.status == 404) {
                        // NO OP/
                    } else {
                        throw ex;
                    }
                }
                const r = await this.localDatabase.put<PlainEntry | NewEntry>(newDoc, { force: true });
                if (typeof this.corruptedEntries[note._id] != "undefined") {
                    delete this.corruptedEntries[note._id];
                }
            });
        } else {
            Logger(`note could not saved:${note._id}`);
        }
    }

    updateInfo: () => void = () => {
        console.log("Update Info default implement");
    };
    // eslint-disable-next-line require-await
    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL.NOTICE);
        // no op now,
        return true;
    }
    replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return new Promise((res, rej) => {
            this.openOneshotReplication(
                setting,
                showingNotice,
                async (e) => { },
                false,
                (e) => {
                    if (e === true) res(e);
                    rej(e);
                },
                "pushOnly"
            );
        });
    }

    async checkReplicationConnectivity(setting: RemoteDBSettings, keepAlive: boolean, skipCheck: boolean, showResult: boolean) {
        if (!this.isReady) {
            Logger("Database is not ready.");
            return false;
        }

        if (setting.versionUpFlash != "") {
            Logger("Open settings and check message, please.", LOG_LEVEL.NOTICE);
            return false;
        }
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        if (this.syncHandler != null) {
            Logger("Another replication running.");
            return false;
        }

        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}: ${dbRet}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
            return false;
        }

        if (!skipCheck) {
            await putDesignDocuments(dbRet.db);
            if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
                Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
                return false;
            }

            const defMilestonePoint: EntryMilestoneInfo = {
                _id: MILSTONE_DOCID,
                type: "milestoneinfo",
                created: (new Date() as any) / 1,
                locked: false,
                accepted_nodes: [this.nodeid],
                node_chunk_info: { [this.nodeid]: currentVersionRange }
            };

            const remoteMilestone: EntryMilestoneInfo = { ...defMilestonePoint, ...(await resolveWithIgnoreKnownError(dbRet.db.get(MILSTONE_DOCID), defMilestonePoint)) };
            remoteMilestone.node_chunk_info = { ...defMilestonePoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
            this.remoteLocked = remoteMilestone.locked;
            this.remoteLockedAndDeviceNotAccepted = remoteMilestone.locked && remoteMilestone.accepted_nodes.indexOf(this.nodeid) == -1;
            const writeMilestone = (
                (
                    remoteMilestone.node_chunk_info[this.nodeid].min != currentVersionRange.min
                    || remoteMilestone.node_chunk_info[this.nodeid].max != currentVersionRange.max
                )
                || typeof remoteMilestone._rev == "undefined");

            if (writeMilestone) {
                remoteMilestone.node_chunk_info[this.nodeid].min = currentVersionRange.min;
                remoteMilestone.node_chunk_info[this.nodeid].max = currentVersionRange.max;
                await dbRet.db.put(remoteMilestone);
            }

            // Check compatibility and make sure available version
            // 
            // v min of A                  v max of A
            // |   v  min of B             |   v max of B
            // |   |                       |   |
            // |   |<---   We can use  --->|   |
            // |   |                       |   |
            //If globalMin and globalMax is suitable, we can upgrade.
            let globalMin = currentVersionRange.min;
            let globalMax = currentVersionRange.max;
            for (const nodeid of remoteMilestone.accepted_nodes) {
                if (nodeid == this.nodeid) continue;
                if (nodeid in remoteMilestone.node_chunk_info) {
                    const nodeinfo = remoteMilestone.node_chunk_info[nodeid];
                    globalMin = Math.max(nodeinfo.min, globalMin);
                    globalMax = Math.min(nodeinfo.max, globalMax);
                } else {
                    globalMin = 0;
                    globalMax = 0;
                }
            }
            this.maxChunkVersion = globalMax;
            this.minChunkVersion = globalMin;

            if (this.chunkVersion >= 0 && (globalMin > this.chunkVersion || globalMax < this.chunkVersion)) {
                if (!setting.ignoreVersionCheck) {
                    Logger("The remote database has no compatibility with the running version. Please upgrade the plugin.", LOG_LEVEL.NOTICE);
                    return false;
                }
            }

            if (remoteMilestone.locked && remoteMilestone.accepted_nodes.indexOf(this.nodeid) == -1) {
                Logger("The remote database has been rebuilt or corrupted since we have synchronized last time. Fetch rebuilt DB or explicit unlocking is required. See the settings dialog.", LOG_LEVEL.NOTICE);
                return false;
            }
        }
        const syncOptionBase: PouchDB.Replication.SyncOptions = {
            batches_limit: setting.batches_limit,
            batch_size: setting.batch_size,
        };
        if (setting.readChunksOnline) {
            syncOptionBase.push = { filter: 'replicate/push' };
            syncOptionBase.pull = { filter: 'replicate/pull' };
        }
        const syncOption: PouchDB.Replication.SyncOptions = keepAlive ? { live: true, retry: true, heartbeat: 30000, ...syncOptionBase } : { ...syncOptionBase };

        return { db: dbRet.db, info: dbRet.info, syncOptionBase, syncOption };
    }

    openReplication(setting: RemoteDBSettings, keepAlive: boolean, showResult: boolean, callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>) {
        if (keepAlive) {
            this.openContinuousReplication(setting, showResult, callback, false);
        } else {
            this.openOneshotReplication(setting, showResult, callback, false, null, "sync");
        }
    }
    replicationActivated(showResult: boolean) {
        this.syncStatus = "CONNECTED";
        this.updateInfo();
        Logger("Replication activated", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
    }
    async replicationChangeDetected(e: PouchDB.Replication.SyncResult<EntryDoc>, showResult: boolean, docSentOnStart: number, docArrivedOnStart: number, callback: ReplicationCallback) {
        try {
            if (e.direction == "pull") {
                await callback(e.change.docs);
                this.docArrived += e.change.docs.length;
            } else {
                this.docSent += e.change.docs.length;
            }
            if (showResult) {
                Logger(`↑${this.docSent - docSentOnStart} ↓${this.docArrived - docArrivedOnStart}`, LOG_LEVEL.NOTICE, "sync");
            }
            this.updateInfo();
        } catch (ex) {
            Logger("Replication callback error", LOG_LEVEL.NOTICE, "sync");
            Logger(ex, LOG_LEVEL.NOTICE);
            //
        }
    }
    replicationCompleted(showResult: boolean) {
        this.syncStatus = "COMPLETED";
        this.updateInfo();
        Logger("Replication completed", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, showResult ? "sync" : "");
        this.syncHandler = this.cancelHandler(this.syncHandler);
    }
    replicationDenied(e: any) {
        this.syncStatus = "ERRORED";
        this.updateInfo();
        this.syncHandler = this.cancelHandler(this.syncHandler);
        Logger("Replication denied", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationErrored(e: any) {
        this.syncStatus = "ERRORED";
        this.syncHandler = this.cancelHandler(this.syncHandler);
        this.updateInfo();
        Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationPaused() {
        this.syncStatus = "PAUSED";
        this.updateInfo();
        Logger("replication paused", LOG_LEVEL.VERBOSE, "sync");
    }

    async openOneshotReplication(
        setting: RemoteDBSettings,
        showResult: boolean,
        callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>,
        retrying: boolean,
        callbackDone: (e: boolean | any) => void,
        syncMode: "sync" | "pullOnly" | "pushOnly"
    ): Promise<boolean> {
        if (this.syncHandler != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        Logger(`Oneshot Sync begin... (${syncMode})`);
        let thisCallback = callbackDone;
        const ret = await this.checkReplicationConnectivity(setting, true, retrying, showResult);
        if (ret === false) {
            Logger("Could not connect to server.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        if (showResult) {
            Logger("Looking for the point last synchronized point.", LOG_LEVEL.NOTICE, "sync");
        }
        const { db, syncOptionBase } = ret;
        this.syncStatus = "STARTED";
        this.updateInfo();
        const docArrivedOnStart = this.docArrived;
        const docSentOnStart = this.docSent;
        if (!retrying) {
            // If initial replication, save setting to rollback
            this.originalSetting = setting;
        }
        this.syncHandler = this.cancelHandler(this.syncHandler);
        if (syncMode == "sync") {
            this.syncHandler = this.localDatabase.sync(db, { checkpoint: "target", ...syncOptionBase });
            this.syncHandler
                .on("change", async (e) => {
                    await this.replicationChangeDetected(e, showResult, docSentOnStart, docArrivedOnStart, callback);
                    if (retrying) {
                        if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                            // restore configuration.
                            Logger("Back into original settings once.");
                            this.syncHandler = this.cancelHandler(this.syncHandler);
                            this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                        }
                    }
                })
                .on("complete", (e) => {
                    this.replicationCompleted(showResult);
                    if (thisCallback != null) {
                        thisCallback(true);
                    }
                });
        } else if (syncMode == "pullOnly") {
            this.syncHandler = this.localDatabase.replicate.from(db, { checkpoint: "target", ...syncOptionBase, ...(this.settings.readChunksOnline ? { filter: "replicate/pull" } : {}) });
            this.syncHandler
                .on("change", async (e) => {
                    await this.replicationChangeDetected({ direction: "pull", change: e }, showResult, docSentOnStart, docArrivedOnStart, callback);
                    if (retrying) {
                        if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                            // restore configuration.
                            Logger("Back into original settings once.");
                            this.syncHandler = this.cancelHandler(this.syncHandler);
                            this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                        }
                    }
                })
                .on("complete", (e) => {
                    this.replicationCompleted(showResult);
                    if (thisCallback != null) {
                        thisCallback(true);
                    }
                });
        } else if (syncMode == "pushOnly") {
            this.syncHandler = this.localDatabase.replicate.to(db, { checkpoint: "target", ...syncOptionBase, ...(this.settings.readChunksOnline ? { filter: "replicate/push" } : {}) });
            this.syncHandler.on("change", async (e) => {
                await this.replicationChangeDetected({ direction: "push", change: e }, showResult, docSentOnStart, docArrivedOnStart, callback);
                if (retrying) {
                    if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                        // restore configuration.
                        Logger("Back into original settings once.");
                        this.syncHandler = this.cancelHandler(this.syncHandler);
                        this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                    }
                }
            })
            this.syncHandler.on("complete", (e) => {
                this.replicationCompleted(showResult);
                if (thisCallback != null) {
                    thisCallback(true);
                }
            });
        }

        this.syncHandler
            .on("active", () => this.replicationActivated(showResult))
            .on("denied", (e) => {
                this.replicationDenied(e);
                if (thisCallback != null) {
                    thisCallback(e);
                }
            })
            .on("error", (e) => {
                this.replicationErrored(e);
                Logger("Replication stopped.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
                if (this.getLastPostFailedBySize()) {
                    // Duplicate settings for smaller batch.
                    const tempSetting: RemoteDBSettings = JSON.parse(JSON.stringify(setting));
                    tempSetting.batch_size = Math.ceil(tempSetting.batch_size / 2) + 2;
                    tempSetting.batches_limit = Math.ceil(tempSetting.batches_limit / 2) + 2;
                    if (tempSetting.batch_size <= 5 && tempSetting.batches_limit <= 5) {
                        Logger("We can't replicate more lower value.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    } else {
                        Logger(`Retry with lower batch size:${tempSetting.batch_size}/${tempSetting.batches_limit}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                        thisCallback = null;
                        this.openOneshotReplication(tempSetting, showResult, callback, true, callbackDone, syncMode);
                    }
                } else {
                    Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
                    Logger(e);
                }
                if (thisCallback != null) {
                    thisCallback(e);
                }
            })
            .on("paused", (e) => this.replicationPaused());

        await this.syncHandler;
    }

    abstract getLastPostFailedBySize(): boolean;
    openContinuousReplication(setting: RemoteDBSettings, showResult: boolean, callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>, retrying: boolean) {
        if (this.syncHandler != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
            return;
        }
        Logger("Before LiveSync, start OneShot once...");
        this.openOneshotReplication(
            setting,
            showResult,
            callback,
            false,
            async () => {
                Logger("LiveSync begin...");
                const ret = await this.checkReplicationConnectivity(setting, true, true, showResult);
                if (ret === false) {
                    Logger("Could not connect to server.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    return;
                }
                if (showResult) {
                    Logger("Looking for the point last synchronized point.", LOG_LEVEL.NOTICE, "sync");
                }
                const { db, syncOption } = ret;
                this.syncStatus = "STARTED";
                this.updateInfo();
                const docArrivedOnStart = this.docArrived;
                const docSentOnStart = this.docSent;
                if (!retrying) {
                    //TODO if successfully saved, roll back org setting.
                    this.originalSetting = setting;
                }
                this.syncHandler = this.cancelHandler(this.syncHandler);
                this.syncHandler = this.localDatabase.sync<EntryDoc>(db, {
                    ...syncOption,
                    pull: {
                        checkpoint: "target",
                    },
                    push: {
                        checkpoint: "source",
                    },
                });
                this.syncHandler
                    .on("active", () => this.replicationActivated(showResult))
                    .on("change", async (e) => {
                        await this.replicationChangeDetected(e, showResult, docSentOnStart, docArrivedOnStart, callback);
                        if (retrying) {
                            if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                                // restore sync values
                                Logger("Back into original settings once.");
                                this.syncHandler = this.cancelHandler(this.syncHandler);
                                this.openContinuousReplication(this.originalSetting, showResult, callback, false);
                            }
                        }
                    })
                    .on("complete", (e) => this.replicationCompleted(showResult))
                    .on("denied", (e) => this.replicationDenied(e))
                    .on("error", (e) => {
                        this.replicationErrored(e);
                        Logger("Replication stopped.", LOG_LEVEL.NOTICE, "sync");
                    })
                    .on("paused", (e) => this.replicationPaused());
            },
            "pullOnly"
        );
    }

    originalSetting: RemoteDBSettings = null;

    closeReplication() {
        this.syncStatus = "CLOSED";
        this.updateInfo();
        this.syncHandler = this.cancelHandler(this.syncHandler);
        Logger("Replication closed");
    }

    async resetLocalOldDatabase() {
        const oldDB = await this.isOldDatabaseExists();
        if (oldDB) {
            oldDB.destroy();
            Logger("Deleted!", LOG_LEVEL.NOTICE);
        } else {
            Logger("Old database is not exist.", LOG_LEVEL.NOTICE);
        }
    }
    abstract onResetDatabase(): Promise<void>;
    async resetDatabase() {
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.closeReplication();
        Logger("Database closed for reset Database.");
        this.isReady = false;
        await this.localDatabase.destroy();
        //await this.kvDB.destroy();
        this.onResetDatabase();
        this.localDatabase = null;
        await this.initializeDatabase();
        Logger("Local Database Reset", LOG_LEVEL.NOTICE);
    }
    async tryResetRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        const con = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof con == "string") return;
        try {
            await con.db.destroy();
            Logger("Remote Database Destroyed", LOG_LEVEL.NOTICE);
            await this.tryCreateRemoteDatabase(setting);
        } catch (ex) {
            Logger("Something happened on Remote Database Destroy:", LOG_LEVEL.NOTICE);
            Logger(ex, LOG_LEVEL.NOTICE);
        }
    }
    async tryCreateRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        const con2 = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);

        if (typeof con2 === "string") return;
        Logger("Remote Database Created or Connected", LOG_LEVEL.NOTICE);
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean) {
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}:${dbRet}`, LOG_LEVEL.NOTICE);
            return;
        }

        if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
            Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
            return;
        }
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: locked,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };

        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...await resolveWithIgnoreKnownError(dbRet.db.get(MILSTONE_DOCID), defInitPoint) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = [this.nodeid];
        remoteMilestone.locked = locked;
        if (locked) {
            Logger("Lock remote database to prevent data corruption", LOG_LEVEL.NOTICE);
        } else {
            Logger("Unlock remote database to prevent data corruption", LOG_LEVEL.NOTICE);
        }
        await dbRet.db.put(remoteMilestone);
    }
    async markRemoteResolved(setting: RemoteDBSettings) {
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}:${dbRet}`, LOG_LEVEL.NOTICE);
            return;
        }

        if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
            Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
            return;
        }
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: false,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };
        // check local database hash status and remote replicate hash status
        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...await resolveWithIgnoreKnownError(dbRet.db.get(MILSTONE_DOCID), defInitPoint) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = Array.from(new Set([...remoteMilestone.accepted_nodes, this.nodeid]));
        Logger("Mark this device as 'resolved'.", LOG_LEVEL.NOTICE);
        await dbRet.db.put(remoteMilestone);
    }
    async sanCheck(entry: EntryDoc): Promise<boolean> {
        if (entry.type == "plain" || entry.type == "newnote") {
            const children = entry.children;
            Logger(`sancheck:checking:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
            try {
                const dc = await this.localDatabase.allDocs({ keys: [...children] });
                if (dc.rows.some((e) => "error" in e)) {
                    this.corruptedEntries[entry._id] = entry;
                    Logger(`sancheck:corrupted:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
                    return false;
                }
                return true;
            } catch (ex) {
                Logger(ex);
            }
        }
        return false;
    }

    isVersionUpgradable(ver: number) {
        if (this.maxChunkVersion < 0) return false;
        if (this.minChunkVersion < 0) return false;
        if (this.maxChunkVersion > 0 && this.maxChunkVersion < ver) return false;
        if (this.minChunkVersion > 0 && this.minChunkVersion > ver) return false;
        return true;
    }

    isTargetFile(file: string) {
        if (file.includes(":")) return true;
        if (this.settings.syncOnlyRegEx) {
            const syncOnly = new RegExp(this.settings.syncOnlyRegEx);
            if (!file.match(syncOnly)) return false;
        }
        if (this.settings.syncIgnoreRegEx) {
            const syncIgnore = new RegExp(this.settings.syncIgnoreRegEx);
            if (file.match(syncIgnore)) return false;
        }
        return true;
    }

    // Collect chunks from both local and remote.
    async CollectChunks(ids: string[], showResult = false) {
        // Fetch local chunks.
        const localChunks = await this.localDatabase.allDocs({ keys: ids, include_docs: true });
        const missingChunks = localChunks.rows.filter(e => "error" in e).map(e => e.key);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.rows.map(e => e.doc);
        }

        // Fetching remote chunks.
        const ret = await this.connectRemoteCouchDBWithSetting(this.settings, this.isMobile);
        if (typeof (ret) === "string") {

            Logger(`Could not connect to server.${ret} `, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }

        const remoteChunks = await ret.db.allDocs({ keys: missingChunks, include_docs: true });
        if (remoteChunks.rows.some((e: any) => "error" in e)) {
            return false;
        }

        const remoteChunkItems = remoteChunks.rows.map((e: any) => e.doc);
        const max = remoteChunkItems.length;
        let last = 0;
        // Chunks should be ordered by as we requested.
        function findChunk(key: string) {
            const offset = last;
            for (let i = 0; i < max; i++) {
                const idx = (offset + i) % max;
                last = i;
                if (remoteChunkItems[idx]._id == key) return remoteChunkItems[idx];
            }
            throw Error("Chunk collecting error");
        }
        // Merge them
        return localChunks.rows.map(e => ("error" in e) ? (findChunk(e.key)) : e.doc);
    }


    connectRemoteCouchDBWithSetting(settings: RemoteDBSettings, isMobile: boolean) {
        return this.connectRemoteCouchDB(
            settings.couchDB_URI + (settings.couchDB_DBNAME == "" ? "" : "/" + settings.couchDB_DBNAME),
            {
                username: settings.couchDB_USER,
                password: settings.couchDB_PASSWORD,
            },
            settings.disableRequestURI || isMobile,
            settings.encrypt ? settings.passphrase : settings.encrypt
        );
    }

    abstract connectRemoteCouchDB(uri: string, auth: { username: string; password: string }, disableRequestURI: boolean, passphrase: string | boolean): Promise<string | { db: PouchDB.Database<EntryDoc>; info: PouchDB.Core.DatabaseInfo }>;
}
