const CP = require("child_process")
const getId = require("random-id")
const getPort = require("random-port")
const net = require("net")
const JSONStream = require("json-stream")

class QSpider {
	constructor(qmpPort, options, proc) {
		// save port and proc
		this._qmpPort = qmpPort
		this._proc = proc

		// create cpu counter from original cpu options
		this._cpus = options.cpus
	}

	// stop the vm
	stop() {
		// kill process
		this._proc.kill()
	}

	async _qmpCommand(command) {
		let commandId = getId(10)

		command.id = commandId

		return await new Promise((resolve, reject) => {
			let qmp = net.connect({ port: this._qmpPort }, () => {
				let sendObj = (obj) => {
					qmp.write(JSON.stringify(obj) + "\n")
				}

				sendObj({ "execute": "qmp_capabilities" })
				sendObj(command)

				let jsonStream = JSONStream()

				qmp.on("data", (data) => {
					jsonStream.write(data.toString())
				})

				// Todo, JSON streaming parser
				jsonStream.on("data", (data) => {
					if (data.QMP != null) return
					if (data.return == null) return

					if (data.id == commandId) {
						qmp.end()
						resolve(data.return)
					}
				})
			})
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

	async _fileSize(path) {
		let res = await new Promise((resolve, reject) => {
			CP.exec(`du -s ${path}`, { cwd: __dirname, }, (error, stdout, stderr) => {
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
		this._options = options
	}


	// start a new vm from iso
	async start(iso) {
		// generate port for qmp service
		let qmpPort = await new Promise((resolve, reject) => {
			getPort({ from: 50000, range: 1000 }, (port) => {
				resolve(port)
			})
		})

		// binary to use
		let command = "qemu-kvm"

		let args = [
			// memory and cpu options
			"-m", this._options.memory.toString(),
			"-cpu", "host",
			"-smp", `${this._options.cpus.toString()},maxcpus=8`,

			// boot options
			"-cdrom", iso,
			"-boot", "d",

			// qmp service and monitor for debug
			"-qmp", `tcp:127.0.0.1:${qmpPort},server,nowait`,
			"-monitor", "tcp:127.0.0.1:4444,server,nowait",

			// "-nographic",

			// dunno what these do lol
			"-enable-kvm",
			"-realtime", "mlock=off",

			// enable ballooning
			"-device", "virtio-balloon",
		]

		// spawn proccess
		let proc = CP.spawn(command, args)

		// Listen for stdout and stderr to debug
		proc.stdout.on("data", (data) => {
			console.log(data)
			console.log(data.toString())
		})

		proc.stderr.on("data", (data) => {
			console.error(data)
			console.error(data.toString())
		})

		// return new instance of a specific qspider
		return new QSpider(qmpPort, this._options, proc)
	}
}

////
// testing
////

let master = new QSpiderMaster({
	memory: 512,
	cpus: 2,
})

;(async () => {
	global.qSpider = await master.start("dsl.iso")

	setInterval(async () => {
		let mem = null
		let cpu = null
		let disksIo = null
		let disks = null

		try {
			mem = await qSpider.memUsage()
			cpu = await qSpider.cpuUsage()
			disksIo = await qSpider.disksIoUsage()
			disks = await qSpider.disksUsage()
		} catch (err) {
			console.error("stats error", err)
			return
		}

		console.log("mem", mem)
		console.log("cpu", cpu)
		console.log("disks io", disksIo)
		console.log("disks", disks)
	}, 4000)
})()