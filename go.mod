module wdmp

go 1.22.2

require (
	github.com/mattn/go-sqlite3 v1.14.48
	github.com/xuri/excelize/v2 v2.8.1
	golang.org/x/crypto v0.19.0
)

require (
	github.com/mohae/deepcopy v0.0.0-20170929034955-c48cc78d4826 // indirect
	github.com/richardlehane/mscfb v1.0.4 // indirect
	github.com/richardlehane/msoleps v1.0.3 // indirect
	github.com/xuri/efp v0.0.0-20231025114914-d1ff6096ae53 // indirect
	github.com/xuri/nfp v0.0.0-20230919160717-d98342af3f05 // indirect
	golang.org/x/net v0.21.0 // indirect
	golang.org/x/text v0.14.0 // indirect
)

replace (
	golang.org/x/crypto => github.com/golang/crypto v0.19.0
	golang.org/x/net => github.com/golang/net v0.21.0
	golang.org/x/text => github.com/golang/text v0.14.0
)
