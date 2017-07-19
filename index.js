const CP = require("child_process")
const getId = require("random-id")
const getPort = require("random-port")
const net = require("net")

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

	// hotplug a new cpu
	async addCpu() {
		return await new Promise((resolve, reject) => {
			let qmp = net.connect({ port: this._qmpPort }, () => {
				this._cpus++
				qmp.write(`{ "execute": "qmp_capabilities" }`)
				qmp.write(`{ "execute": "device_add", "arguments": { "driver": "qemu64-x86_64-cpu", "id": "cpu${this._cpus}", "socket-id": ${this._cpus}, "core-id": 0, "thread-id": 0 } }`)

				// Todo, JSON streaming parser
				qmp.on("data", (data) => {
					let res = JSON.parse(data.toString())

					if (res.QMP != null) return

					if (res.return != null) {
						qmp.end()
						resolve(res.return)
					}
				})
			})
		})
	}

	// set new balloon ammount
	async setBalloon(bytes) {
		return await new Promise((resolve, reject) => {
			let qmp = net.connect({ port: this._qmpPort }, () => {
				qmp.write(`{ "execute": "qmp_capabilities" }`)
				qmp.write(`{ "execute": "balloon", "arguments": { "value": ${bytes} }, "id": "balloon" }`)

				// Todo, JSON streaming parser
				qmp.on("data", (data) => {
					let res = JSON.parse(data.toString())

					if (res.QMP != null) return

					if (res.return != null) {
						qmp.end()
						resolve(res.return)
					}
				})
			})
		})
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

		try {
			mem = await qSpider.memUsage()
			cpu = await qSpider.cpuUsage()
		} catch (err) {
			console.error("stats error", err)
			return
		}

		console.log("mem", mem)
		console.log("cpu", cpu)
	}, 10000)
})()