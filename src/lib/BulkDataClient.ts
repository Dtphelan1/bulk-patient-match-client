import { promisify, debuglog }          from "util"
import jwt                              from "jsonwebtoken"
import jose                             from "node-jose"
import { URL, fileURLToPath }           from "url"
import { EventEmitter }                 from "events"
import aws                              from "aws-sdk"
import { basename, join, resolve, sep } from "path"
import FS, { mkdirSync }                from "fs"
import { expect }                       from "@hapi/code"
import { OptionsOfUnknownResponseBody } from "got/dist/source"
import { PassThrough, Readable, Stream, Writable } from "stream"
import request                          from "./request"
import FileDownload                     from "./FileDownload"
import ParseNDJSON                      from "./ParseNDJSON"
import StringifyNDJSON                  from "./StringifyNDJSON"
import DocumentReferenceHandler         from "./DocumentReferenceHandler"
import { BulkDataClient as Types }      from "../.."
import {
    assert,
    fhirInstant,
    formatDuration,
    getAccessTokenExpiration,
    wait
} from "./utils"

EventEmitter.defaultMaxListeners = 30;

const pipeline = promisify(Stream.pipeline);
const debug = debuglog("app-request")

export interface BulkDataClientEvents {
    "authorize"       : (accessToken: string) => void;
    "kickOffStart"    : () => void;
    "kickOffEnd"      : (statusLocation: string) => void;
    "exportStart"     : (status: Types.ExportStatus) => void;
    "exportProgress"  : (status: Types.ExportStatus) => void;
    "exportComplete"  : (manifest: Types.ExportManifest) => void;
    "downloadStart"   : (downloads: Types.FileDownload[]) => void;
    "downloadProgress": (downloads: Types.FileDownload[]) => void;
    "downloadComplete": (downloads: Types.FileDownload[]) => void;
    "error"           : (error: Error) => void;
    "abort"           : () => void;
}


interface BulkDataClient {

    on<U extends keyof BulkDataClientEvents>(event: U, listener: BulkDataClientEvents[U]): this;
    // on(event: string, listener: Function): this;

    emit<U extends keyof BulkDataClientEvents>(event: U, ...args: Parameters<BulkDataClientEvents[U]>): boolean;
    // emit(event: string, ...args: any[]): boolean;
}

class BulkDataClient extends EventEmitter
{
    /**
     * The options of the instance
     */
    private readonly options: Types.NormalizedOptions;

    /**
     * Used internally to emit abort signals to pending requests and other async
     * jobs.
     */
    private abortController: AbortController;

    /**
     * The last known access token is stored here. It will be renewed when it
     * expires. 
     */
    private accessToken: string = "";

    /**
     * Every time we get new access token, we set this field based on the
     * token's expiration time.
     */
    private accessTokenExpiresAt: number = 0;

    /**
     * Nothing special is done here - just remember the options and create
     * AbortController instance
     */
    constructor(options: Types.NormalizedOptions)
    {
        super();
        this.options = options;
        this.abortController = new AbortController();
        this.abortController.signal.addEventListener("abort", () => {
            this.emit("abort")
        });
        
    }

    public async request<T=unknown>(options: OptionsOfUnknownResponseBody, label = "request")
    {
        const _options: OptionsOfUnknownResponseBody = {
            ...this.options.requests,
            ...options,
            headers: {
                ...this.options.requests.headers,
                ...options.headers
            }
        }

        const accessToken = await this.getAccessToken();

        if (accessToken) {
            _options.headers = {
                ...options.headers,
                authorization: `bearer ${ accessToken }`
            };
        }

        const req = request<T>(_options as any);

        const abort = () => {
            debug(`Aborting ${label}`)
            req.cancel()
        };

        this.abortController.signal.addEventListener("abort", abort, { once: true });

        return req.then(res => {
            this.abortController.signal.removeEventListener("abort", abort);
            return res
        });
    }

    /**
     * Get an access token to be used as bearer in requests to the server.
     * The token is cached so that we don't have to authorize on every request.
     * If the token is expired (or will expire in the next 10 seconds), a new
     * one will be requested and cached.
     */
    private async getAccessToken()
    {
        if (this.accessToken && this.accessTokenExpiresAt - 10 > Date.now() / 1000) {
            return this.accessToken;
        }

        const { tokenUrl, clientId, accessTokenLifetime, privateKey } = this.options;

        if (!tokenUrl || tokenUrl == "none" || !clientId || !privateKey) {
            return ""
        }

        const claims = {
            iss: clientId,
            sub: clientId,
            aud: tokenUrl,
            exp: Math.round(Date.now() / 1000) + accessTokenLifetime,
            jti: jose.util.randomBytes(10).toString("hex")
        };

        const token = jwt.sign(claims, privateKey.toPEM(true), {
            algorithm: privateKey.alg as jwt.Algorithm,
            keyid: privateKey.kid
        });

        const authRequest = request<Types.TokenResponse>(tokenUrl, {
            method: "POST",
            responseType: "json",
            form: {
                scope: "system/*.read",
                grant_type: "client_credentials",
                client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                client_assertion: token
            }
        });

        const abort = () => {
            debug("Aborting authorization request")
            authRequest.cancel()
        };

        this.abortController.signal.addEventListener("abort", abort, { once: true });

        return authRequest.then(res => {
            assert(res.body, "Authorization request got empty body")
            assert(res.body.access_token, "Authorization response does not include access_token")
            assert(res.body.expires_in, "Authorization response does not include expires_in")
            this.accessToken = res.body.access_token || ""
            this.accessTokenExpiresAt = getAccessTokenExpiration(res.body)
            this.emit("authorize", this.accessToken)
            return res.body.access_token
        }).finally(() => {
            this.abortController.signal.removeEventListener("abort", abort);
        });
    }

    /**
     * Makes the kick-off request and resolves with the status endpoint URL
     */
    public async kickOff(): Promise<string>
    {
        const { fhirUrl, global, group, lenient } = this.options;

        this.emit("kickOffStart")

        if (global) {
            var url = new URL("$export", fhirUrl);
        }
        else if (group) {
            var url = new URL(`Group/${group}/$export`, fhirUrl);
        }
        else {
            var url = new URL("Patient/$export", fhirUrl);
        }

        this.buildKickOffQuery(url.searchParams)

        return this.request({
            url,
            responseType: "json",
            headers: {
                accept: "application/fhir+json",
                prefer: `respond-async${lenient ? ", handling=lenient" : ""}`
            }
        }, "kick-off request").then(res => {
            const location = res.headers["content-location"];
            assert(location, "The kick-off response did not include content-location header")
            this.emit("kickOffEnd", location)
            return location
        });
    }

    /**
     * Waits for the export to be completed and resolves with the export
     * manifest when done. Emits one "exportStart", multiple "exportProgress"
     * and one "exportComplete" events.
     * 
     * If the server replies with "retry-after" header we will use that to
     * compute our pooling frequency, but the next pool will be scheduled for
     * not sooner than 1 second and not later than 10 seconds from now.
     * Otherwise, the default pooling frequency is 1 second.
     */
    public async waitForExport(statusEndpoint: string): Promise<Types.ExportManifest>
    {
        const status = {
            startedAt      : Date.now(),
            completedAt    : -1,
            elapsedTime    : 0,
            percentComplete: -1,
            nextCheckAfter : 1000,
            message        : "Bulk Data export started"
        };

        this.emit("exportStart", status)

        const checkStatus: () => Promise<Types.ExportManifest> = async () => {
            
            return this.request<Types.ExportManifest>({
                url: statusEndpoint,
                throwHttpErrors: false,
                responseType: "json",
                headers: {
                    accept: "application/json"
                }
            }, "status request").then(res => {
                const now = Date.now();
                const elapsedTime = now - status.startedAt
                
                status.elapsedTime = elapsedTime

                // Export is complete
                if (res.statusCode == 200) {
                    status.completedAt = now
                    status.percentComplete = 100
                    status.nextCheckAfter = -1
                    status.message = `Bulk Data export completed in ${formatDuration(elapsedTime)}`
                    this.emit("exportProgress", status)

                    expect(res.body, "No export manifest returned").to.exist()
                    expect(res.body.output, "The export manifest output is not an array").to.be.an.array();
                    expect(res.body.output, "The export manifest output contains no files").to.not.be.empty()

                    this.emit("exportComplete", res.body)
                    // debug("%o", status)
                    return res.body
                }

                // Export is in progress
                if (res.statusCode == 202) {
                    const now = Date.now();

                    let progress    = String(res.headers["x-progress"] || "").trim();
                    let retryAfter  = String(res.headers["retry-after"] || "").trim();
                    let progressPct = parseInt(progress, 10);

                    let retryAfterMSec = 1000;
                    if (retryAfter.match(/\d+/)) {
                        retryAfterMSec = parseInt(retryAfter, 10) * 1000
                    } else {
                        let d = new Date(retryAfter);
                        retryAfterMSec = Math.ceil(d.getTime() - now)
                    }

                    const poolDelay = Math.min(Math.max(retryAfterMSec/10, 1000), 10000)

                    Object.assign(status, {
                        percentComplete: isNaN(progressPct) ? -1 : progressPct,
                        nextCheckAfter: poolDelay,
                        message: isNaN(progressPct) ?
                            `Bulk Data export: in progress for ${formatDuration(elapsedTime)}${progress ? ". Server message: " + progress : ""}`:
                            `Bulk Data export: ${progressPct}% complete in ${formatDuration(elapsedTime)}`
                    });

                    this.emit("exportProgress", status)
                    // debug("%o", status)
                    
                    return wait(poolDelay, this.abortController.signal).then(checkStatus)
                }
                else {
                    // TODO: handle unexpected response
                    throw new Error(`Unexpected status response ${res.statusCode} ${res.statusMessage}`)
                    // this.emit("error", status)
                }
            });

        };
        
        return checkStatus()
    }

    public async downloadFiles(manifest: Types.ExportManifest)
    {
        
        return new Promise((resolve, reject) => {

            // Count how many files we have gotten for each ResourceType. This
            // is needed if the forceStandardFileNames option is true
            const fileCounts: { [key: string]: number } = {}

            const createDownloadJob = (f: Types.ExportManifestFile, initialState: Partial<Types.FileDownload> = {}) => {

                if (!(f.type in fileCounts)) {
                    fileCounts[f.type] = 0;
                }
                fileCounts[f.type]++;

                let fileName = basename(f.url)
                if (this.options.forceStandardFileNames) {
                    fileName = `${fileCounts[f.type]}.${f.type}.ndjson`
                }

                const status: Types.FileDownload = {
                    url              : f.url,
                    type             : f.type,
                    name             : fileName,
                    downloadedChunks : 0,
                    downloadedBytes  : 0,
                    uncompressedBytes: 0,
                    resources        : 0,
                    attachments      : 0,
                    running          : false,
                    completed        : false,
                    exportType       : "output",
                    error            : null,
                    ...initialState
                }

                return {
                    status,
                    descriptor: f,
                    worker: async () => {
                        status.running = true
                        status.completed = false
                        this.downloadFile(
                            f,
                            fileName,
                            state => {
                                Object.assign(status, state)
                                this.emit("downloadProgress", downloadJobs.map(j => j.status))
                            },
                            () => {
                                status.running = false
                                status.completed = true

                                if (this.options.addDestinationToManifest) {
                                    // @ts-ignore
                                    f.destination = join(this.options.destination, fileName)
                                }
                                tick()
                            },
                            true,
                            status.exportType == "output" ? "" : status.exportType,
                            status.exportType
                        )
                    }
                };
            };

            const downloadJobs = [
                ...(manifest.output  || []).map(f => createDownloadJob(f, { exportType: "output"  })),
                ...(manifest.deleted || []).map(f => createDownloadJob(f, { exportType: "deleted" })),
                ...(manifest.error   || []).map(f => createDownloadJob(f, { exportType: "error"   }))
            ];

            const tick = () => {
                
                let completed = 0
                let running   = 0
                for (const job of downloadJobs) {
                    if (job.status.completed) {
                        completed += 1
                        continue
                    }
                    if (job.status.running) {
                        running += 1
                        continue
                    }
                    if (running < this.options.parallelDownloads) {
                        running += 1
                        job.worker()
                    }
                }

                this.emit("downloadProgress", downloadJobs.map(j => j.status))

                if (completed === downloadJobs.length) {
                    if (this.options.saveManifest) {
                        this.writeToDestination(
                            "manifest.json",
                            Readable.from(JSON.stringify(manifest, null, 4))
                        ).then(() => {
                            this.emit("downloadComplete", downloadJobs.map(j => j.status))
                            resolve(downloadJobs.map(j => j.status))
                        });
                    } else {
                        this.emit("downloadComplete", downloadJobs.map(j => j.status))
                        resolve(downloadJobs.map(j => j.status))
                    }
                }
            };

            this.emit("downloadStart", downloadJobs.map(j => j.status))

            tick()
        })
    }

    private async downloadFile(
        file: Types.ExportManifestFile,
        fileName: string,
        onProgress: (state: Partial<Types.FileDownloadProgress>) => any,
        onComplete: () => any,
        authorize = false,
        subFolder = "",
        exportType = "output"
    )
    {
        let accessToken = ""

        if (authorize) {
            accessToken = await this.getAccessToken()
        }

        const download = new FileDownload(file.url)

        // Collect different properties form different events. The aggregate
        // object will be used to emit progress events once, after a FHIR 
        // resource has been parsed 
        let _state = {
            ...download.getState(),
            resources: 0,
            attachments: 0
        }

        // Just "remember" the progress values but don't emit anything yet
        download.on("progress", state => Object.assign(_state, state))

        // Start the download (the stream will be paused though)
        const downloadStream = await download.run({
            accessToken,
            signal: this.abortController.signal,
            requestOptions: this.options.requests
        });


        let expectedResourceType = ""
        if (this.options.ndjsonValidateFHIRResourceType) {
            switch (exportType) {
                case "output": expectedResourceType = file.type; break;
                case "deleted": expectedResourceType = "Bundle" ; break;
                case "error": expectedResourceType = "OperationOutcome"; break;
                default: expectedResourceType = ""; break;
            }
        }

        // Create an NDJSON parser to verify that every single line can be
        // parsed as JSON
        const parser = new ParseNDJSON({
            maxLineLength: this.options.ndjsonMaxLineLength,
            expectedCount: exportType == "output" ? file.count || -1 : -1,
            expectedResourceType
        })
        
        // Transforms from stream of objects back to stream of strings (lines)
        const stringify = new StringifyNDJSON()

        const docRefProcessor = new DocumentReferenceHandler({
            request: this.request.bind(this),
            save: (name: string, stream: Readable, subFolder: string) => this.writeToDestination(name, stream, subFolder),
            inlineAttachments: this.options.inlineDocRefAttachmentsSmallerThan,
            inlineAttachmentTypes: this.options.inlineDocRefAttachmentTypes,
            pdfToText: this.options.pdfToText,
            baseUrl: this.options.fhirUrl
        })

        docRefProcessor.on("attachment", () => _state.attachments += 1)

        const processPipeline = downloadStream
            .pipe(parser)
            .pipe(docRefProcessor)
            .pipe(stringify)
            .pause();

        // When we get an object from a line emit the progress event
        stringify.on("data", () => {
            _state.resources += 1
            onProgress(_state)
        });

        await this.writeToDestination(fileName, processPipeline, subFolder)
        
        onComplete()
    
        // if (fileType !== "attachment") {
        //     /**
        //      * Convert to stream of JSON objects
        //      * @type {*}
        //      */
        //     pipeline = decompress.pipe(new NdJsonStream());

        //     pipeline.on("data", () => this.setState("objects", this.state.objects + 1));

        //     // Handle DocumentReference with absolute URLs
        //     pipeline = pipeline.pipe(new DocumentReferenceHandler({
        //         dir,
        //         gzip : !!decompress,
        //         accessToken: this.options.accessToken,
        //         onAttachment: this.options.onAttachment
        //     }));
        // }


    }

    private writeToDestination(fileName: string, inputStream: Readable, subFolder = "") {
        const destination = String(this.options.destination || "none").trim();

        // No destination ------------------------------------------------------
        if (!destination || destination.toLowerCase() == "none") {
            return pipeline(inputStream, new Writable({
                write(chunk, encoding, cb) { cb() }
            }))
        }

        // S3 ------------------------------------------------------------------
        if (destination.startsWith("s3://")) {
            assert(
                this.options.awsAccessKeyId,
                "Please set the 'awsAccessKeyId' property in your config file",
                { description: "The 'awsAccessKeyId' configuration option is required if the 'destination' option is an S3 uri" }
            )
            assert(
                this.options.awsSecretAccessKey,
                "Please set the 'awsSecretAccessKey' property in your config file",
                { description: "The 'awsSecretAccessKey' configuration option is required if the 'destination' option is an S3 uri" }
            )
            assert(
                this.options.awsRegion,
                "Please set the 'awsRegion' property in your config file",
                { description: "The 'awsRegion' configuration option is required if the 'destination' option is an S3 uri" }
            )

            aws.config.update({
                apiVersion     : this.options.awsApiVersion,
                region         : this.options.awsRegion,
                accessKeyId    : this.options.awsAccessKeyId,
                secretAccessKey: this.options.awsSecretAccessKey
            });

            let bucket = destination.substring(5);
            if (subFolder) {
                bucket = join(bucket, subFolder)
            }

            const upload = new aws.S3.ManagedUpload({
                params: {
                    Bucket: bucket,
                    Key   : fileName,
                    Body  : inputStream
                }
            });

            return upload.promise()
        }

        // HTTP ----------------------------------------------------------------
        if (destination.match(/^https?\:\/\//)) {
            return pipeline(
                inputStream,
                request.stream.post(join(destination, fileName) + "?folder=" + subFolder),
                new PassThrough()
            );
        }

        // local filesystem destinations ---------------------------------------
        let path = destination.startsWith("file://") ?
            fileURLToPath(destination) :
            destination.startsWith(sep) ?
                destination :
                resolve(__dirname, "../..", destination);

        assert(FS.existsSync(path), `Destination "${path}" does not exist`)
        assert(FS.statSync(path).isDirectory, `Destination "${path}" is not a directory`)

        if (subFolder) {
            path = join(path, subFolder)
            if (!FS.existsSync(path)) {
                mkdirSync(path)
            }
        }

        return pipeline(inputStream, FS.createWriteStream(join(path, fileName)));
    }

    private buildKickOffQuery(params: URLSearchParams): URLSearchParams
    {
        if (this.options._outputFormat) {
            params.append("_outputFormat", this.options._outputFormat);
        }

        const since = fhirInstant(this.options._since);
        if (since) {
            params.append("_since", since);
        }

        if (this.options._type) {
            params.append("_type", this.options._type);
        }

        if (this.options._elements) {
            params.append("_elements", this.options._elements);
        }

        if (this.options.includeAssociatedData) {
            params.append("includeAssociatedData", this.options.includeAssociatedData);
        }

        if (this.options._typeFilter) {
            params.append("_typeFilter", this.options._typeFilter);
        }

        return params
    }

    public abort() {
        this.abortController.abort()
    }
}

export default BulkDataClient
