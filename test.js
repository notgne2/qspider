let QSpiderMaster = require("./")

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