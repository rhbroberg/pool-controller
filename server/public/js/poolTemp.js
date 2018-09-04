/* global google document fetch window */

google.charts.load('current', { packages: ['corechart', 'line'] });
google.charts.setOnLoadCallback(drawBasic);

function drawBasic() {
    var chart = new google.visualization.LineChart(document.getElementById('chart_div'));
    var options = {
        hAxis: {
            title: 'Time'
        },
        vAxis: {
            title: 'Temperature'
        }
    };
    var data = new google.visualization.DataTable();

    data.addColumn('string', 'date');
    data.addColumn('number', 'Pool');
    const url = `http://${window.location.host}/rhbroberg/pool-api/1.0.0/temperature/pool?date=2018-08-22T00:00:00.000Z&limit=128`;

    // or else use https://stackoverflow.com/questions/12460378/how-to-get-json-from-url-in-javascript
    fetch(url)
        .then(res => res.json())
        .then((rsp) => {
            data.addRows(rsp.zoneStatus[0].values);
            chart.draw(data, options);
        })
        .catch(err => { throw err; });
}
