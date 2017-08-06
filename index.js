const CP = require("child_process")
const EventEmitter = require("events").EventEmitter
const getId = require("random-id")
const getPort = require("random-port")
const net = require("net")
const JSONStream = require("json-stream")
const path = require("path")
const randomMac = require("random-mac")

class QSpider extends EventEmitter {
	constructor(qmpPort, options, proc) {
		super()

		// save port and proc
		this._qmpPort = qmpPort
		this._proc = proc

		// Qmp socket connection
		this._qmp = null
		this._qmpReader = null

		// create cpu counter from original cpu options
		this._cpus = options.cpus

		// Images dir
		this._imagesDir = options.imagesDir

		// Build stuff
		this._build()
	}

	async _build() {
		// Listen for stderr to debug
		this._proc.stderr.on("data", (data) => {
			this.emit("error", data.toString())
		})
	}

	async _connectQmp() {
		return await new Promise((resolve, reject) => {
			let qmp = net.connect({ port: this._qmpPort }, () => {
				let jsonStream = JSONStream()

				qmp.on("data", (data) => {
					jsonStream.write(data.toString())
				})

				this._qmp = qmp
				this._qmpReader = jsonStream

				resolve()
			})
		})
	}

	// stop the vm
	stop() {
		// kill process
		this._proc.kill()
	}

	async _qmpCommand(command) {
		// If QMP not connected, connect and run again afterwards
		if (!this._qmpReader || !this._qmp) {
			await this._connectQmp()
			return await this._qmpCommand(command)
		}

		let commandId = getId(10)
		command.id = commandId

		return await new Promise(async (resolve, reject) => {
			// Macro for sending objects to QMP
			let sendObj = (obj) => {
				this._qmp.write(JSON.stringify(obj) + "\n")
			}

			// Send init and command
			sendObj({ "execute": "qmp_capabilities" })
			sendObj(command)

			// Listener that handles responses
			let listener = (data) => {
				// Check if correct type
				if (data.QMP != null) return
				if (data.return == null) return

				if (data.id == commandId) {
					// Data is response, resolve promise and stop listening
					this._qmpReader.removeListener("data", listener)
					resolve(data.return)
				}
			}

			// Listen for data
			this._qmpReader.on("data", listener)
		})
	}

	// hotplug a new cpu
	async addCpu() {
		this._cpus++
		return await this._qmpCommand({ "execute": "device_add", "arguments": { "driver": "qemu64-x86_64-cpu", "socket-id": this._cpus, "core-id": 0, "thread-id": 0 } })
	}

	// set new balloon ammount
	async setBalloon(bytes) {
		return await this._qmpCommand({ "execute": "balloon", "arguments": { "value": bytes } })
	}

	// get cpu usage
	async cpuUsage() {
		let res = await new Promise((resolve, reject) => {
			CP.exec(`ps -p ${this._proc.pid} -o %cpu`, (error, stdout, stderr) => {
				if (error != null) {
					reject(error)
					return
				}

				if (stdout && !stderr) {
					resolve(stdout)
				} else {
					reject(stderr)
				}
			})
		})


		let resLines = res.toString().split("\n")

		return resLines[1].substr(1)
	}

	// get memory usage
	async memUsage() {
		let res = await new Promise((resolve, reject) => {
			CP.exec(`ps -p ${this._proc.pid} -o %mem`, (error, stdout, stderr) => {
				if (error != null) {
					reject(error)
					return
				}

				if (stdout && !stderr) {
					resolve(stdout)
				} else {
					reject(stderr)
				}
			})
		})

		let resLines = res.toString().split("\n")

		return resLines[1].substr(1)
	}

	async disksIoUsage() {
		let res = await this._qmpCommand({ "execute": "query-blockstats" })

		return res.map((disk) => {
			return {
				device: disk.device,
				bytesRead: disk.stats.rd_bytes,
				bytesWritten: disk.stats.wr_bytes,
			}
		})
	}

	async _fileSize(filePath) {
		let res = await new Promise((resolve, reject) => {
			CP.exec(`du -s ${filePath}`, { cwd: this._imagesDir, }, (error, stdout, stderr) => {
				if (error != null) {
					reject(error)
					return
				}

				if (stdout && !stderr) {
					resolve(stdout)
				} else {
					reject(stderr)
				}
			})
		})


		let resLines = res.toString().split("\n")

		return resLines[0].split(/\s/g)[0]
	}


	async disksUsage() {
		let res = await this._qmpCommand({ "execute": "query-block" })

		let diskFiles = res.filter((disk) => {
			return disk.inserted != null
		}).map((disk) => {
			return {
				device: disk.device,
				path: disk.inserted.file,
				type: disk.inserted.drv,
			}
		})

		return await Promise.all(diskFiles.map(async (diskFile) => {
			return {
				device: diskFile.device,
				size: await this._fileSize(diskFile.path),
			}
		}))
	}
}


class QSpiderMaster {
	constructor(options) {
		// save options
		this.options = options
	}

	async convert(format, input, output, imagesDir) {
		if (imagesDir == null) imagesDir = this.options.imagesDir

		return await new Promise((resolve, reject) => {
			let inputPath = path.join(imagesDir, input)
			let outputPath = path.join(imagesDir, output)

			let cmd = `qemu-img convert -f ${format} -O qcow2 ${inputPath} ${outputPath}`

			CP.exec(cmd, (err, stdout, stderr) => {
				if (err) {
					reject(err)
					return
				} else if (stderr) {
					reject(stderr)
				} else {
					resolve()
				}
			})
		})
	}

	// start a new vm from iso
	async start(image, mac, memory, cpus, bin, imagesDir) {
		if (mac == null) mac = randomMac()

		if (memory == null) memory = this.options.memory
		if (cpus == null) cpus = this.options.cpus

		if (imagesDir == null) imagesDir = this.options.imagesDir

		if (bin == null) bin = "qemu-kvm"

		// generate port for qmp service
		let qmpPort = await new Promise((resolve, reject) => {
			getPort({ from: 50000, range: 1000 }, (port) => {
				resolve(port)
			})
		})

		let args = [
			// memory and cpu options
			"-m", memory.toString(),
			"-cpu", "host",
			"-smp", `${cpus.toString()},maxcpus=16`,

			// boot options
			"-hda", path.join(imagesDir, image),
			"-boot", "c",

			// qmp service
			"-qmp", `tcp:127.0.0.1:${qmpPort},server,nowait`,

			// Don't open a window for the VM
			"-nographic",

			// dunno what these do lol
			"-enable-kvm",
			"-realtime", "mlock=off",

			// Set net mac address stuff
			"-device", "e1000,netdev=netthing0,mac=${mac}",
			"-netdev", "tap,id=netthing0",

			// enable ballooning
			"-device", "virtio-balloon",
		]

		// spawn proccess
		let proc = CP.spawn(bin, args)

		// Create new options object
		let options = {
			cpus: cpus,
			memory: memory,
			imagesDir: imagesDir,
		}

		// return new instance of a specific qspider
		return new QSpider(qmpPort, options, proc)
	}
}

module.exports = exports = QSpiderMaster
